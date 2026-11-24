"""Fake Telethon for tests/copy_listener_ops.test.mjs: only what deploy/linux/copy_listener.py uses. No network.

FAKE_TG_SCRIPT (JSON file):
  history        [{id, age (seconds before now), text}]  returned by iter_messages (newest first, min_id honoured)
  duringCatchup  [{id, text}]                             dispatched as live copy messages while iter_messages runs
  live           [{delay, id, text, chat?}]               dispatched after connect (chat defaults to the copy channel)
  disconnectedAfter  seconds: is_connected() turns False after this long (Telethon reconnecting)
"""
import asyncio, datetime, json, os

_SCRIPT = {}
if os.environ.get('FAKE_TG_SCRIPT'):
    with open(os.environ['FAKE_TG_SCRIPT'], encoding='utf-8') as f:
        _SCRIPT = json.load(f)
_CHANNEL = int(os.environ.get('COPY_CHANNEL_ID', '0') or 0)


def _log(*a):
    print('[FAKE]', *a, flush=True)


class _Msg:
    def __init__(self, mid, text, date=None):
        self.id = mid
        self.message = text
        self.date = date or datetime.datetime.now(datetime.timezone.utc)


class _Event:
    def __init__(self, chat_id, msg):
        self.chat_id = chat_id
        self.message = msg


class _Entity:
    def __init__(self, name):
        self.id = abs(hash(name)) % 1000000 + 1
        self.username = str(name)
        self.title = str(name)


class events:
    class NewMessage:
        def __init__(self, chats=None, incoming=None):
            self.chats = chats
            self.incoming = incoming


class utils:
    @staticmethod
    def get_peer_id(ent):
        return ent.id


class TelegramClient:
    def __init__(self, session, api_id, api_hash):
        self.handlers = []
        self._connected = False
        self._disc = None
        self._t0 = None

    def on(self, ev):
        def deco(fn):
            self.handlers.append((ev, fn))
            return fn
        return deco

    async def _dispatch(self, chat, mid, text):
        ev = _Event(chat, _Msg(mid, text))
        for spec, fn in self.handlers:
            if spec.chats is not None and spec.chats != chat:
                continue
            await fn(ev)

    async def _live(self):
        for item in _SCRIPT.get('live', []):
            await asyncio.sleep(float(item.get('delay', 0)))
            await self._dispatch(int(item.get('chat', _CHANNEL)), int(item['id']), item['text'])

    async def start(self):
        await self.connect()

    async def connect(self):
        loop = asyncio.get_running_loop()
        self._connected = True
        self._t0 = loop.time()
        self._disc = loop.create_future()
        self._live_task = asyncio.create_task(self._live())

    async def is_user_authorized(self):
        return True

    def is_connected(self):
        after = _SCRIPT.get('disconnectedAfter')
        if self._connected and after is not None and asyncio.get_event_loop().time() - self._t0 >= float(after):
            return False
        return self._connected

    async def get_entity(self, x):
        return _Entity(x)

    async def iter_messages(self, chat, limit=None, min_id=0):
        _log('iter_messages', json.dumps({'chat': chat, 'limit': limit, 'min_id': min_id}))
        for item in _SCRIPT.get('duringCatchup', []):
            await self._dispatch(_CHANNEL, int(item['id']), item['text'])
        now = datetime.datetime.now(datetime.timezone.utc)
        rows = sorted(_SCRIPT.get('history', []), key=lambda r: -int(r['id']))
        n = 0
        for r in rows:
            if int(r['id']) <= (min_id or 0):
                continue
            if limit is not None and n >= limit:
                break
            n += 1
            yield _Msg(int(r['id']), r['text'], now - datetime.timedelta(seconds=float(r.get('age', 0))))

    async def run_until_disconnected(self):
        await self._disc

    async def disconnect(self):
        self._connected = False
        if self._disc is not None and not self._disc.done():
            self._disc.set_result(None)
