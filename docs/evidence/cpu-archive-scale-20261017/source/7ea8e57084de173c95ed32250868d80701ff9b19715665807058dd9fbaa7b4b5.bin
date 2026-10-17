"""Telegram incident delivery. Configuration and delivery state stay outside Git."""
import argparse, datetime, json, os, re, time, urllib.error, urllib.request
from pathlib import Path

PRIVATE = Path('/opt/telomere-mainnet-pilot/private')


def atomic(path, value):
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)


def telegram(token, method, payload):
    if not re.fullmatch(r'[0-9]{5,16}:[A-Za-z0-9_-]{20,100}', token):
        raise ValueError('Invalid bot credential format')
    request = urllib.request.Request('https://api.telegram.org/bot' + token + '/' + method,
        data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    # Never expose exception URLs: they contain the bot credential.
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read(1024 * 1024))
    except urllib.error.HTTPError as error:
        raise RuntimeError('Telegram HTTP status ' + str(error.code)) from None
    except Exception:
        raise RuntimeError('Telegram transport unavailable') from None
    if not result.get('ok'):
        raise RuntimeError('Telegram rejected operation')
    return result['result']


def delivery_plan(previous, alerts, current, repeat_seconds=3600):
    alerts = sorted(set(alerts))
    if alerts:
        if previous.get('alerts') != alerts or current - previous.get('sentAt', 0) >= repeat_seconds:
            return {'kind': 'incident', 'alerts': alerts}
    elif previous.get('alerts'):
        return {'kind': 'recovery', 'alerts': []}
    return None


def send(token, chat_id, source, kind, alerts):
    if not re.fullmatch(r'-?[1-9][0-9]{0,19}', str(chat_id)):
        raise ValueError('Numeric Telegram chat required')
    if source not in ('vps', 'external') or kind not in ('incident', 'recovery', 'test'):
        raise ValueError('Invalid notification kind')
    if any(not re.fullmatch(r'[A-Z][A-Z0-9_]{0,70}', item) for item in alerts) or len(alerts) > 40:
        raise ValueError('Invalid alert codes')
    title = {'incident': 'ALERT', 'recovery': 'RECOVERED', 'test': 'DELIVERY TEST'}[kind]
    text = 'Telomere CPU: ' + title + '\nSource: ' + source + '\n'
    text += ', '.join(alerts) if alerts else 'Operational check completed.'
    text += '\nUTC: ' + datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    result = telegram(token, 'sendMessage', {'chat_id': str(chat_id), 'text': text,
        'link_preview_options': {'is_disabled': True}})
    return {'messageId': result['message_id'], 'sentAt': time.time()}


def bind(expected_username):
    token = (PRIVATE / 'telegram-bot-token').read_text().strip()
    bot = telegram(token, 'getMe', {})
    if telegram(token, 'getWebhookInfo', {}).get('url'):
        raise RuntimeError('Bot already has a webhook; dedicated bot required')
    updates = telegram(token, 'getUpdates', {'timeout': 0, 'allowed_updates': ['message']})
    matches = []
    for update in updates:
        message = update.get('message', {})
        sender, chat = message.get('from', {}), message.get('chat', {})
        if (sender.get('username', '').lower() == expected_username.lower().lstrip('@')
            and chat.get('type') == 'private' and sender.get('id') == chat.get('id')
            and message.get('text', '').split(' ')[0] == '/start'
            and time.time() - message.get('date', 0) < 86400):
            matches.append(message)
    if not matches:
        raise RuntimeError('Expected recipient must send /start to the bot')
    message = max(matches, key=lambda item: item['date'])
    chat_id = str(message['chat']['id'])
    config = {'chatId': chat_id, 'username': expected_username.lstrip('@'), 'bot': bot['username']}
    proof = send(token, chat_id, 'vps', 'test', [])
    atomic(PRIVATE / 'cpu-telegram.json', config)
    atomic(PRIVATE / 'cpu-telegram-binding.json', {**proof, 'bot': bot['username'],
        'recipient': expected_username.lstrip('@'), 'testDelivered': True})
    print(json.dumps({'bound': True, 'bot': bot['username'], 'recipient': expected_username, **proof}))


def local_alerts():
    observation = json.loads((PRIVATE / 'cpu-monitor-status.json').read_text())
    observed = datetime.datetime.fromisoformat(observation['observedAt']).timestamp()
    alerts = observation.get('alerts', [])
    if time.time() - observed > 300:
        alerts = alerts + ['LOCAL_MONITOR_STALE']
    return alerts


def notify():
    state_file = PRIVATE / 'cpu-vps-pager-state.json'
    try:
        previous = json.loads(state_file.read_text())
    except FileNotFoundError:
        previous = {}
    try:
        alerts = local_alerts()
    except Exception:
        alerts = ['LOCAL_MONITOR_UNREADABLE']
    plan = delivery_plan(previous, alerts, time.time())
    if not plan:
        return
    config = json.loads((PRIVATE / 'cpu-telegram.json').read_text())
    proof = send((PRIVATE / 'telegram-bot-token').read_text().strip(), config['chatId'], 'vps', plan['kind'], plan['alerts'])
    atomic(state_file, {**plan, **proof})  # Failed delivery never suppresses a retry.
    print(json.dumps({'delivered': True, 'kind': plan['kind'], **proof}))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['bind', 'notify'])
    parser.add_argument('--recipient')
    args = parser.parse_args()
    try:
        if args.command == 'bind':
            if not args.recipient or not re.fullmatch(r'@?[A-Za-z0-9_]{5,32}', args.recipient):
                raise ValueError('An explicit private recipient is required')
            bind(args.recipient)
        else:
            notify()
    except Exception as error:
        print(json.dumps({'delivered': False, 'errorType':type(error).__name__}))
        raise SystemExit(1)
