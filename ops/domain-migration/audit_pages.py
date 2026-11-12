"""Crawl existing public pages and inspect domain-bearing markup. No wallet use."""
import concurrent.futures
import json
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ORIGIN = 'https://my-telomere.com'
LEGACY = re.compile(r'telomere\.sh|telomere-compute\.sleroy1312\.chatgpt\.site', re.I)


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values, self.pages, self.canonical = [], [], []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        for key in ['href', 'src', 'action', 'poster', 'srcset']:
            if attributes.get(key):
                self.values.append(attributes[key])
        if tag == 'meta' and attributes.get('content'):
            self.values.append(attributes['content'])
        if tag == 'a' and attributes.get('href'):
            self.pages.append(attributes['href'])
        if tag == 'link' and attributes.get('rel') == 'canonical':
            self.canonical.append(attributes.get('href'))


def page(path):
    request = urllib.request.Request(ORIGIN + path, headers={'User-Agent': 'Telomere-domain-audit/1'})
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.status == 200 and urllib.parse.urlsplit(response.geturl()).netloc == 'my-telomere.com', path
        assert 'text/html' in response.headers['Content-Type'], path
        raw = response.read(4 * 1024 * 1024).decode('utf-8')
    parsed = Links()
    parsed.feed(raw)
    assert not LEGACY.search(raw), 'Legacy domain in page source: ' + path
    assert not any(LEGACY.search(value) for value in parsed.values), path
    if path == '/':
        assert parsed.canonical == [ORIGIN + '/'], parsed.canonical
    return path, parsed


def main():
    root = Path(__file__).resolve().parents[2] / 'website/dist'
    pending = {'/' + path.parent.relative_to(root).as_posix().strip('.') + '/' for path in root.rglob('index.html')}
    pending = {path.replace('//', '/') for path in pending} | {'/motion.html'}
    seen, attributes = set(), 0
    while pending:
        assert len(seen | pending) <= 128, 'Unexpected public page inventory growth'
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(page, sorted(pending)))
        seen.update(pending)
        pending = set()
        for path, parsed in rows:
            attributes += len(parsed.values)
            for value in parsed.pages:
                target = urllib.parse.urlsplit(urllib.parse.urljoin(ORIGIN + path, value))
                route = target.path or '/'
                if target.scheme != 'https' or target.netloc != 'my-telomere.com':
                    continue
                if route in seen or '.' in route or re.match(r'^/(api|v1|health|console|mcp|x402)(/|$)', route):
                    continue
                pending.add(route)
    print(json.dumps({'passed': True, 'origin': ORIGIN, 'pages': len(seen), 'domainAttributes': attributes,
                      'routes': sorted(seen), 'legacyReferences': 0, 'walletSignatures': 0, 'transactionsSent': 0}))


if __name__ == '__main__':
    main()
