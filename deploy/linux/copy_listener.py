#!/usr/bin/env python3
"""Signal Lab copy-trading listener (user 2026-11-13).

Reads the followed private Telegram channel with the user's own Telegram account (Telethon) and
passes each new message to the local Signal Lab server, which copies it on the BingX TESTNET
(copy_executor.mjs). Nothing is sent anywhere else. Settings come from /opt/signallab/data/.env:
  TELEGRAM_API_ID / TELEGRAM_API_HASH   from https://my.telegram.org (the user creates them)
  COPY_CHANNEL_ID                        e.g. -1003995199859 (t.me/c/3995199859)
  COPY_LISTENER_TOKEN                    shared with the server (copy.sh creates it)
  SIGNAL_LAB_PORT                        default 3000 (the server's PORT)
The login session file (copy.session) stays in the data folder, readable only by signallab.
"""
import asyncio, json, os, sys, urllib.request
from telethon import TelegramClient, events

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
URL = f"http://127.0.0.1:{E.get('SIGNAL_LAB_PORT', E.get('PORT', '3000'))}/api/copy/message"
if not (API_ID and API_HASH and CHANNEL and len(TOKEN) >= 24):
    sys.exit('설정 누락: TELEGRAM_API_ID, TELEGRAM_API_HASH, COPY_CHANNEL_ID, COPY_LISTENER_TOKEN (copy.sh로 설정)')

def post(payload):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Copy-Token': TOKEN})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()[:300]

client = TelegramClient(os.path.join(DATA, 'copy'), API_ID, API_HASH)

@client.on(events.NewMessage(chats=CHANNEL))
async def on_message(event):
    msg = event.message
    payload = {'id': msg.id, 'date': int(msg.date.timestamp() * 1000), 'text': msg.message or ''}
    if not payload['text']:
        return
    try:
        res = await asyncio.get_running_loop().run_in_executor(None, post, payload)
        print(f"[COPY] {msg.id} -> {res}", flush=True)
    except Exception as e:  # the server may be restarting: try once more shortly after
        print(f"[COPY] {msg.id} 전달 실패: {e}", flush=True)
        await asyncio.sleep(5)
        try:
            res = await asyncio.get_running_loop().run_in_executor(None, post, payload)
            print(f"[COPY] {msg.id} -> {res} (재시도)", flush=True)
        except Exception as e2:
            print(f"[COPY] {msg.id} 재시도 실패: {e2}", flush=True)

async def main():
    await client.start()  # first run (copy.sh): asks for the phone number and the login code
    if len(sys.argv) > 1 and sys.argv[1] == '--login':
        ent = await client.get_entity(CHANNEL)
        print('로그인 완료 · 채널 확인:', getattr(ent, 'title', CHANNEL)); return
    print('[COPY] 채널 수신 대기 중', flush=True)
    await client.run_until_disconnected()

asyncio.run(main())
