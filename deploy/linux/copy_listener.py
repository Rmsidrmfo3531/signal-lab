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
"""
import asyncio, http.client, json, os, sys, threading, urllib.error, urllib.request
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

async def deliver(payload):
    msg_id = payload['id']
    # The server may be restarting (an update takes up to about a minute): retry for about 3 minutes.
    # The server ignores a message id it has already handled, so a retry never trades twice.
    for wait in (0, 1, 2, 5, 10, 15, 20, 30, 30, 30):
        if wait:
            await asyncio.sleep(wait)
        try:
            res = await asyncio.get_running_loop().run_in_executor(None, post, payload)
            print(f"[COPY] {msg_id} -> {res}" + (f" (재시도, {wait}초 대기 후)" if wait else ''), flush=True)
            return
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', errors='replace')[:200]
            except Exception:
                pass
            if 400 <= e.code < 500 and e.code != 429:
                print(f"[COPY] {msg_id} 영구 오류 HTTP {e.code} (재시도 중단): {detail}", flush=True)
                return
            print(f"[COPY] {msg_id} 전달 실패 HTTP {e.code}: {detail}", flush=True)
        except Exception as e:
            print(f"[COPY] {msg_id} 전달 실패: {e}", flush=True)
    print(f"[COPY] {msg_id} 최종 전달 실패 (약 3분 재시도)", flush=True)

async def delivery_worker():
    while True:
        payload = await delivery_queue.get()
        try:
            await deliver(payload)
        finally:
            delivery_queue.task_done()

@client.on(events.NewMessage(chats=CHANNEL))
async def on_message(event):
    msg = event.message
    text = (msg.message or '')[:4000]
    if not text:
        return
    payload = {'id': msg.id, 'date': int(msg.date.timestamp() * 1000), 'text': text}
    if delivery_queue is not None:
        await delivery_queue.put(payload)
    else:
        await deliver(payload)

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
    while True:
        payload = await pump_queue.get()
        try:
            await deliver_pump(payload)
        except Exception as e:
            print(f"[PUMP] 처리 오류: {e}", flush=True)
        finally:
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
        # Never waits: a full queue drops this alert instead of holding up Telethon's update dispatch.
        pump_queue.put_nowait({'id': msg.id, 'chat': str(event.chat_id), 'date': int(msg.date.timestamp() * 1000), 'text': text})
    except asyncio.QueueFull:
        print('[PUMP] 대기열 가득 참 — 알림 1건 버림', flush=True)
    except Exception as e:
        print(f"[PUMP] 수신 오류: {e}", flush=True)

async def main():
    global delivery_queue, pump_queue
    login_mode = len(sys.argv) > 1 and sys.argv[1] == '--login'
    if login_mode or sys.stdin.isatty():
        await client.start()  # first run (copy.sh): asks for the phone number and the login code
    else:
        await client.connect()
        if not await client.is_user_authorized():
            sys.exit('[COPY] 텔레그램 세션이 만료되었거나 로그인되지 않았습니다. copy.sh로 다시 로그인하세요.')
    if login_mode:
        ent = await client.get_entity(CHANNEL)
        print('로그인 완료 · 채널 확인:', getattr(ent, 'title', CHANNEL)); return
    delivery_queue = asyncio.Queue()
    worker = asyncio.create_task(delivery_worker())
    pump_tasks = []
    if PUMP_CHATS:
        pump_queue = asyncio.Queue(maxsize=500)
        pump_tasks = [asyncio.create_task(pump_worker()), asyncio.create_task(resolve_pump_chats())]
    else:
        print('[PUMP] PUMP_ALERT_CHATS 비어 있음 — 급변 알림 꺼짐', flush=True)
    print('[COPY] 채널 수신 대기 중', flush=True)
    try:
        await client.run_until_disconnected()
    finally:
        worker.cancel()
        for t in pump_tasks:
            t.cancel()

asyncio.run(main())
