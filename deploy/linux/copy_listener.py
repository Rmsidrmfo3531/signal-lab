#!/usr/bin/env python3
"""Signal Lab copy-trading listener (user 2026-11-13).

Reads the followed private Telegram channel with the user's own Telegram account (Telethon) and
passes each new message to the local Signal Lab server, which copies it on the BingX TESTNET
(copy_executor.mjs). Nothing is sent anywhere else. Settings come from /opt/signallab/data/.env:
  TELEGRAM_API_ID / TELEGRAM_API_HASH   from https://my.telegram.org (the user creates them)
  COPY_CHANNEL_ID                        e.g. -1001234567890 (t.me/c/1234567890)
  COPY_LISTENER_TOKEN                    shared with the server (copy.sh creates it)
  SIGNAL_LAB_PORT                        default 3000 (the server's PORT)
  PUMP_ALERT_CHATS                       급변 알림 chats (user 2026-11-24): comma-separated usernames or ids, default
                                         ggangalt2_bot; empty = off. Each message goes to /api/pump-alert (same token).
                                         Separate handler, queue and connection: the copy channel is handled as before,
                                         and a chat that cannot be resolved is logged and skipped (never exits).
The login session file (copy.session) stays in the data folder, readable only by signallab.

Liveness and self-restart (user decision 2026-11-24 17:34 "2번은 그대로 진행"):
  - Every 60 s a heartbeat goes to /api/copy/heartbeat (same token): version (hash of this file), Telethon connected,
    last copy message id/time, last pump alert time, queue sizes. Its own task, thread and connection: it never waits on
    or breaks the copy handler. The server alerts "카피 수신 끊김" / "카피 수신 복구" from it.
  - Every 60 s this file's hash is compared with the one it started with. When an update changed it (and the new file
    compiles), the listener waits until no copy POST is in flight and both queues are empty (at most 30 s; if still busy
    it tries again at the next check), then exits with code 0; systemd (Restart=always) starts the new code ~10 s later.
  - On start, messages of the copy channel that arrived while it was not running (newer than the last forwarded id in
    copy-listener-state.json, at most 20, and only those at most COPY_CATCHUP_MAX_AGE_SEC = 120 s old) are forwarded
    in order before live ones. The server handles each message id once (copy_executor seen list), so a message sent
    twice is never traded twice. COPY_CATCHUP_MAX_AGE_SEC=0 turns this off.
    Only a complete gap is sent (review 2026-11-24): when one missed text message is older than the age limit, there
    are more than 20, or reading the channel failed, NONE of the missed ones are sent (as before this catch-up), since
    the rest would reach the copy executor without what came before them (a MONITOR_START cut off makes its
    re-announced positions new entries / adds; a close cut off before a re-entry makes it an add). The saved id is
    kept per channel (another channel's id is ignored).
"""
import asyncio, concurrent.futures, hashlib, http.client, json, os, sys, threading, time, urllib.error, urllib.request
from telethon import TelegramClient, events, utils

# Ensure SQLite session files (-wal/-shm/-journal) are created 0600 only.
os.umask(0o077)

def env(path):
    out = {}
    try:
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1); out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out

DATA = os.environ.get('SIGNAL_LAB_DATA_DIR', '/opt/signallab/data')
E = {**env(os.path.join(DATA, '.env')), **os.environ}
API_ID, API_HASH = int(E.get('TELEGRAM_API_ID', '0') or 0), E.get('TELEGRAM_API_HASH', '')
CHANNEL = int(E.get('COPY_CHANNEL_ID', '0') or 0)
TOKEN = E.get('COPY_LISTENER_TOKEN', '')
PORT = int(E.get('SIGNAL_LAB_PORT', E.get('PORT', '3000')) or 3000)
URL = f"http://127.0.0.1:{PORT}/api/copy/message"
PUMP_PATH = '/api/pump-alert'
# Unset = the bot the user subscribed to; an explicit empty value turns the pump alerts off.
PUMP_CHATS = [x.strip().lstrip('@') for x in (E['PUMP_ALERT_CHATS'] if 'PUMP_ALERT_CHATS' in E else 'ggangalt2_bot').split(',') if x.strip()]
if not (API_ID and API_HASH and CHANNEL and len(TOKEN) >= 24):
    sys.exit('설정 누락: TELEGRAM_API_ID, TELEGRAM_API_HASH, COPY_CHANNEL_ID, COPY_LISTENER_TOKEN (copy.sh로 설정)')

def _int_env(name, default, lo, hi):
    try:
        return max(lo, min(hi, int(float(E.get(name, default)))))
    except (TypeError, ValueError):
        return default

SCRIPT = os.path.abspath(__file__)
STATE_FILE = os.path.join(DATA, 'copy-listener-state.json')
HEARTBEAT_PATH = '/api/copy/heartbeat'
HEARTBEAT_SEC = _int_env('COPY_HEARTBEAT_SEC', 60, 1, 600)
SELF_CHECK_SEC = _int_env('COPY_SELF_CHECK_SEC', 60, 1, 3600)
DRAIN_WAIT_SEC = _int_env('COPY_RESTART_DRAIN_SEC', 30, 1, 120)
CATCHUP_MAX_AGE_SEC = _int_env('COPY_CATCHUP_MAX_AGE_SEC', 120, 0, 600)
CATCHUP_LIMIT = 20
CATCHUP_FETCH = CATCHUP_LIMIT * 3  # posts without text (photos, service messages) count toward one history read too

def file_hash(path):
    try:
        with open(path, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None

START_HASH = file_hash(SCRIPT) or ''
VERSION = START_HASH[:12] or 'unknown'
now_ms = lambda: int(time.time() * 1000)
STATS = {'startedAt': now_ms(), 'lastCopyId': None, 'lastCopyAt': None, 'lastCopyDeliveredAt': None, 'lastPumpAt': None,
         'catchup': None}
copy_in_flight = 0   # copy payloads being delivered right now (deliver() running)
pump_in_flight = 0
catchup_buffer = None  # a list while the start catch-up runs: live copy messages wait in it (kept in id order)
catchup_running = False

_conn_lock = threading.Lock()
_conn = None

def post(payload):
    global _conn
    body = json.dumps(payload).encode()
    headers = {'Content-Type': 'application/json', 'X-Copy-Token': TOKEN, 'Connection': 'keep-alive'}
    with _conn_lock:
        for attempt in range(2):
            try:
                if _conn is None:
                    _conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=20)
                _conn.request('POST', '/api/copy/message', body=body, headers=headers)
                resp = _conn.getresponse()
                raw = resp.read().decode('utf-8', errors='replace')
                if resp.status >= 400:
                    raise urllib.error.HTTPError(URL, resp.status, resp.reason, resp.headers, None) if not raw else _http_err(resp.status, resp.reason, raw)
                return raw[:300]
            except urllib.error.HTTPError:
                raise
            except Exception:
                try:
                    if _conn is not None:
                        _conn.close()
                except Exception:
                    pass
                _conn = None
                if attempt == 1:
                    raise

def _http_err(code, reason, body_text):
    err = urllib.error.HTTPError(URL, code, reason, {}, None)
    err.read = lambda: body_text.encode('utf-8', errors='replace')
    return err

client = TelegramClient(os.path.join(DATA, 'copy'), API_ID, API_HASH)
delivery_queue = None
pump_queue = None
pump_ids = set()   # resolved peer ids of PUMP_CHATS (filled in main; the handler ignores everything else)

def load_state():
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}

def last_forwarded_id():
    """The saved last id for THIS channel, or None: no file, a corrupt one, another channel's id (COPY_CHANNEL_ID was
    changed; its id would hide this channel's messages and never be overwritten) or a value that is no message id."""
    st = load_state()
    last = st.get('lastId')
    if st.get('channel', CHANNEL) != CHANNEL or type(last) is not int or not 0 < last < 2 ** 31:
        return None
    return last

def save_forwarded(payload):
    """The last copy message id the server has answered for (copy-listener-state.json, 0600). Never raises."""
    try:
        last = last_forwarded_id()
        if last is not None and last >= payload['id']:
            return
        tmp = STATE_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'channel': CHANNEL, 'lastId': payload['id'], 'lastDate': payload.get('date'), 'savedAt': now_ms()}, f)
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        print(f"[COPY] 상태 저장 실패: {type(e).__name__}", flush=True)

async def deliver(payload):
    global copy_in_flight
    copy_in_flight += 1
    try:
        if await _deliver(payload):
            STATS['lastCopyDeliveredAt'] = now_ms()
            save_forwarded(payload)
    finally:
        copy_in_flight -= 1

async def _deliver(payload):
    msg_id = payload['id']
    # The server may be restarting (an update takes up to about a minute): retry for about 3 minutes.
    # The server ignores a message id it has already handled, so a retry never trades twice.
    for wait in (0, 1, 2, 5, 10, 15, 20, 30, 30, 30):
        if wait:
            await asyncio.sleep(wait)
        try:
            res = await asyncio.get_running_loop().run_in_executor(None, post, payload)
            print(f"[COPY] {msg_id} -> {res}" + (f" (재시도, {wait}초 대기 후)" if wait else ''), flush=True)
            return True
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', errors='replace')[:200]
            except Exception:
                pass
            if 400 <= e.code < 500 and e.code != 429:
                print(f"[COPY] {msg_id} 영구 오류 HTTP {e.code} (재시도 중단): {detail}", flush=True)
                return True
            print(f"[COPY] {msg_id} 전달 실패 HTTP {e.code}: {detail}", flush=True)
        except Exception as e:
            print(f"[COPY] {msg_id} 전달 실패: {e}", flush=True)
    print(f"[COPY] {msg_id} 최종 전달 실패 (약 3분 재시도)", flush=True)
    return False

async def delivery_worker():
    while True:
        payload = await delivery_queue.get()
        try:
            await deliver(payload)
        finally:
            delivery_queue.task_done()

def copy_payload(msg):
    text = (getattr(msg, 'message', None) or '')[:4000]
    if not text or getattr(msg, 'date', None) is None:
        return None
    return {'id': msg.id, 'date': int(msg.date.timestamp() * 1000), 'text': text}

@client.on(events.NewMessage(chats=CHANNEL))
async def on_message(event):
    payload = copy_payload(event.message)
    if not payload:
        return
    STATS['lastCopyId'], STATS['lastCopyAt'] = payload['id'], now_ms()
    if catchup_buffer is not None:
        catchup_buffer.append(payload)  # sent right after the missed ones, in id order
        return
    if delivery_queue is not None:
        await delivery_queue.put(payload)
    else:
        await deliver(payload)

async def catch_up():
    """Copy messages that arrived while the listener was not running (restart gap): newer than the last forwarded id,
    at most CATCHUP_LIMIT, and only up to CATCHUP_MAX_AGE_SEC old (an older card is stale: no late entry from it).
    Live messages received meanwhile wait in catchup_buffer; both go out in id order, each id once. Never raises.
    Only a complete gap goes out: a missed text message older than the age limit, more than CATCHUP_LIMIT of them, or a
    failed read means none of the missed ones are sent (the rest would arrive without what came before them)."""
    global catchup_buffer, catchup_running
    found, error, gap = [], None, None
    try:
        if CATCHUP_MAX_AGE_SEC > 0:
            last = last_forwarded_id()
            cutoff = time.time() - CATCHUP_MAX_AGE_SEC
            kwargs = {'limit': CATCHUP_FETCH}
            if last is not None:
                kwargs['min_id'] = last
            async def fetch():
                nonlocal gap
                read = 0
                async for m in client.iter_messages(CHANNEL, **kwargs):  # newest first (only ids after `last`)
                    read += 1
                    p = copy_payload(m)
                    date = getattr(m, 'date', None)
                    if date is not None and date.timestamp() < cutoff:
                        if last is None:
                            return  # no saved id: only the recent window is looked at
                        if p:
                            gap = 'OLD'  # missed, but too old to send: everything after it would lack it
                            return
                        continue  # an old post without text was never forwarded anyway; older text ones still count
                    if p:
                        found.append(p)
                        if len(found) > CATCHUP_LIMIT:
                            gap = 'LIMIT'
                            return
                if read >= CATCHUP_FETCH:
                    gap = 'LIMIT'  # one read was full: older missed messages may lie beyond it
            await asyncio.wait_for(fetch(), timeout=20)
    except Exception as e:
        error = type(e).__name__
        print(f"[COPY] 놓친 메시지 확인 실패 ({error}) — 새 메시지만 받습니다", flush=True)
    finally:
        buffered = catchup_buffer or []
        catchup_buffer = None
        skipped = 0
        if error or gap:
            # Never a part: the oldest missed ones are not in it (or unknown), so none of them go out.
            skipped = len([p for p in found if p['id'] not in {b['id'] for b in buffered}])
            found = []
            if gap:
                why = f"{CATCHUP_MAX_AGE_SEC}초보다 오래된 메시지가 있음" if gap == 'OLD' else f"{CATCHUP_LIMIT}건 넘음"
                print(f"[COPY] 재시작 동안 놓친 메시지를 다시 보내지 않습니다 ({why}, 최근 {skipped}건 포함) — 앞부분이 빠진 채"
                      " 보내면 모니터 재시작 카드가 새 진입·추매로 처리될 수 있습니다. 채널을 직접 확인하세요", flush=True)
        merged, seen = [], set()
        for p in sorted(found + buffered, key=lambda x: x['id']):
            if p['id'] not in seen:
                seen.add(p['id'])
                merged.append(p)
        for p in merged:
            delivery_queue.put_nowait(p)
        catchup_running = False
        missed = len([p for p in found if p['id'] not in {b['id'] for b in buffered}])
        STATS['catchup'] = {'forwarded': missed, 'skipped': skipped, 'at': now_ms(),
                            'error': error or (f'GAP_{gap}' if gap else None)}
        if missed:
            print(f"[COPY] 재시작 동안 놓친 메시지 {missed}건 전달 (최근 {CATCHUP_MAX_AGE_SEC}초 안, 서버가 같은 id는 한 번만 처리)", flush=True)

# ---- 급변 알림 (pump alerts) -------------------------------------------------------------------
# Kept apart from the copy path: its own queue and worker, a fresh short-lived connection per POST (never the copy
# connection or its lock), a shorter retry, and every error caught here.
def post_pump(payload):
    body = json.dumps(payload).encode()
    conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    try:
        conn.request('POST', PUMP_PATH, body=body, headers={'Content-Type': 'application/json', 'X-Copy-Token': TOKEN})
        resp = conn.getresponse()
        raw = resp.read().decode('utf-8', errors='replace')
        return resp.status, raw[:200]
    finally:
        conn.close()

async def deliver_pump(payload):
    for wait in (0, 2, 5, 10, 20, 30):
        if wait:
            await asyncio.sleep(wait)
        try:
            status, raw = await asyncio.get_running_loop().run_in_executor(None, post_pump, payload)
            if status < 400:
                print(f"[PUMP] {payload['id']} -> {raw}", flush=True)
                return
            print(f"[PUMP] {payload['id']} HTTP {status}: {raw}", flush=True)
            if 400 <= status < 500 and status != 429:
                return
        except Exception as e:
            print(f"[PUMP] {payload['id']} 전달 실패: {e}", flush=True)
    print(f"[PUMP] {payload['id']} 최종 전달 실패", flush=True)

async def pump_worker():
    global pump_in_flight
    while True:
        payload = await pump_queue.get()
        pump_in_flight += 1
        try:
            await deliver_pump(payload)
        except Exception as e:
            print(f"[PUMP] 처리 오류: {e}", flush=True)
        finally:
            pump_in_flight -= 1
            pump_queue.task_done()

async def resolve_pump_chats():
    """Resolve PUMP_CHATS to peer ids. A chat that cannot be resolved is logged and skipped, then tried again
    every 10 minutes; the copy listener keeps running either way."""
    pending = list(PUMP_CHATS)
    while pending:
        left = []
        for name in pending:
            try:
                ent = await client.get_entity(int(name) if name.lstrip('-').isdigit() else name)
                pump_ids.add(utils.get_peer_id(ent))
                print(f"[PUMP] 알림 수신: {getattr(ent, 'username', None) or getattr(ent, 'title', None) or name}", flush=True)
            except Exception as e:
                print(f"[PUMP] {name} 확인 실패 (10분 뒤 다시 시도): {type(e).__name__}", flush=True)
                left.append(name)
        pending = left
        if pending:
            await asyncio.sleep(600)

@client.on(events.NewMessage(incoming=True))
async def on_pump_message(event):
    # No chats= filter here on purpose: an unresolvable chat in an event filter would raise inside Telethon's
    # dispatch, next to the copy handler. Ids are compared here instead.
    try:
        if not pump_ids or event.chat_id not in pump_ids or pump_queue is None:
            return
        msg = event.message
        text = (msg.message or '')[:4000]
        if not text:
            return
        STATS['lastPumpAt'] = now_ms()
        # Never waits: a full queue drops this alert instead of holding up Telethon's update dispatch.
        pump_queue.put_nowait({'id': msg.id, 'chat': str(event.chat_id), 'date': int(msg.date.timestamp() * 1000), 'text': text})
    except asyncio.QueueFull:
        print('[PUMP] 대기열 가득 참 — 알림 1건 버림', flush=True)
    except Exception as e:
        print(f"[PUMP] 수신 오류: {e}", flush=True)

# ---- 하트비트 · 자동 재시작 (user decision 2026-11-24 17:34) ---------------------------------------------------------
# Own thread pool (one thread) and a fresh short connection per beat: a slow or dead server never holds up the copy POSTs.
_hb_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='heartbeat')

def heartbeat_payload():
    try:
        connected = bool(client.is_connected())
    except Exception:
        connected = False
    return {'version': VERSION, 'connected': connected, 'pid': os.getpid(), **{k: v for k, v in STATS.items()},
            'queues': {'copy': delivery_queue.qsize() if delivery_queue is not None else 0,
                       'pump': pump_queue.qsize() if pump_queue is not None else 0},
            'inFlight': copy_in_flight}

def post_heartbeat(payload):
    conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
    try:
        conn.request('POST', HEARTBEAT_PATH, body=json.dumps(payload).encode(),
                     headers={'Content-Type': 'application/json', 'X-Copy-Token': TOKEN})
        resp = conn.getresponse()
        return resp.status, resp.read(200).decode('utf-8', errors='replace')
    finally:
        conn.close()

async def heartbeat_loop():
    failing = False
    while True:
        try:
            status, raw = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(_hb_pool, post_heartbeat, heartbeat_payload()), timeout=15)
            if status >= 400 and not failing:
                print(f"[HEARTBEAT] 서버 응답 HTTP {status}: {raw[:120]}", flush=True)
            failing = status >= 400
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not failing:  # logged once per outage, not every minute
                print(f"[HEARTBEAT] 전송 실패: {type(e).__name__}", flush=True)
            failing = True
        await asyncio.sleep(HEARTBEAT_SEC)

def busy():
    return bool(catchup_running or copy_in_flight or pump_in_flight
                or (delivery_queue is not None and delivery_queue.qsize())
                or (pump_queue is not None and pump_queue.qsize()))

def compiles(path):
    try:
        with open(path, 'rb') as f:
            compile(f.read(), path, 'exec')
        return True
    except Exception:
        return False

restart_requested = False

async def self_update_watch():
    """Exit cleanly after an update changed this file, so systemd (Restart=always) runs the new code."""
    global restart_requested
    bad_hash = None
    while True:
        await asyncio.sleep(SELF_CHECK_SEC)
        try:
            h = file_hash(SCRIPT)
            if not h or h == START_HASH:
                continue
            if not compiles(SCRIPT):
                if h != bad_hash:
                    print(f"[COPY] 새 버전({h[:12]})이 문법 검사를 통과하지 못해 지금 버전({VERSION})으로 계속 받습니다", flush=True)
                    bad_hash = h
                continue
            loop = asyncio.get_running_loop()
            deadline = loop.time() + DRAIN_WAIT_SEC
            while busy() and loop.time() < deadline:
                await asyncio.sleep(0.5)
            if busy():
                print(f"[COPY] 새 버전 감지 — 전달 중인 메시지가 있어 {SELF_CHECK_SEC}초 뒤 다시 확인", flush=True)
                continue
            print(f"[COPY] 새 버전 감지 ({VERSION} → {h[:12]}) — 대기열 비움 확인, 종료 후 systemd가 새 코드로 다시 시작", flush=True)
            restart_requested = True
            await client.disconnect()
            return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[COPY] 업데이트 확인 오류: {type(e).__name__}", flush=True)

async def main():
    global delivery_queue, pump_queue, catchup_buffer, catchup_running
    login_mode = len(sys.argv) > 1 and sys.argv[1] == '--login'
    if not login_mode:
        # Before connecting: live copy messages that arrive during the start catch-up wait in this buffer.
        delivery_queue = asyncio.Queue()
        catchup_buffer, catchup_running = [], True
    if login_mode or sys.stdin.isatty():
        await client.start()  # first run (copy.sh): asks for the phone number and the login code
    else:
        await client.connect()
        if not await client.is_user_authorized():
            sys.exit('[COPY] 텔레그램 세션이 만료되었거나 로그인되지 않았습니다. copy.sh로 다시 로그인하세요.')
    if login_mode:
        ent = await client.get_entity(CHANNEL)
        print('로그인 완료 · 채널 확인:', getattr(ent, 'title', CHANNEL)); return
    worker = asyncio.create_task(delivery_worker())
    pump_tasks = []
    if PUMP_CHATS:
        pump_queue = asyncio.Queue(maxsize=500)
        pump_tasks = [asyncio.create_task(pump_worker()), asyncio.create_task(resolve_pump_chats())]
    else:
        print('[PUMP] PUMP_ALERT_CHATS 비어 있음 — 급변 알림 꺼짐', flush=True)
    ops_tasks = [asyncio.create_task(heartbeat_loop()), asyncio.create_task(self_update_watch())]
    await catch_up()
    print(f'[COPY] 채널 수신 대기 중 (버전 {VERSION})', flush=True)
    try:
        await client.run_until_disconnected()
    finally:
        if restart_requested:
            # A message that came in between the last check and the disconnect still goes out (at most 20 s).
            try:
                await asyncio.wait_for(delivery_queue.join(), timeout=20)
            except Exception:
                pass
        worker.cancel()
        for t in pump_tasks + ops_tasks:
            t.cancel()
        _hb_pool.shutdown(wait=False, cancel_futures=True)

asyncio.run(main())
