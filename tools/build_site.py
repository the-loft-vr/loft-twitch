"""Build THE LOFT's Twitch site for GitHub Pages from the Worker's /export snapshot.

usage: python build_site.py <export.json> <out_dir> [<previous_site_url>]

Writes (all small enough for the iPad's 8 KB string limit; each list < 7000 bytes):
  l/c<k>.json        chip k (0..13), all languages, up to 40 streams
  l/l<i>_<p>.json    language pool i (0 en,1 ja,2 zh,3 ru,4 ko,5 fr,6 de,7 ar,8 es,9 other), page p (0..1), up to 40 streams
  a/<list>_<r>.jpg   thumbnail atlas for that list, rotation r (0/1): 5 columns x 8 rows of 192x108, row-major from the top
  meta.json          {t, r, mock, chips}
  baked.json         the baked channel list (copied from the repo) for the Unity installer
The atlas alternates between two names (r) so a player holding the previous list still gets the matching picture.
"""
import json, os, sys, io, urllib.request, concurrent.futures as cf
from PIL import Image, ImageDraw, ImageFont

CW, CH, COLS, ROWS = 192, 108, 5, 8
LIMIT = 6900
CHIPS = 14

def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'loft-twitch-site/1'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def tile_for(entry, font):
    th = entry.get('th') or ''
    if th.startswith('https://static-cdn.jtvnw.net/'):
        try:
            im = Image.open(io.BytesIO(fetch(th))).convert('RGB')
            return im.resize((CW, CH), Image.LANCZOS)
        except Exception:
            pass
    # placeholder (mock data, or no preview yet): the Loft's dark felt green, thin gold frame, cream name
    h = sum(map(ord, entry['l'])) % 10
    im = Image.new('RGB', (CW, CH), (16 + h, 24 + h, 19 + h))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, CW - 1, CH - 1], outline=(201, 163, 94), width=2)
    name = entry.get('d') or entry['l']
    d.text((CW // 2, CH // 2), name[:16], fill=(242, 237, 219), anchor='mm', font=font)
    return im

def pack(key, entries, t, r, chips):
    """One list file; titles shrink until it fits LIMIT bytes."""
    tmax = 48
    while True:
        e = []
        for x in entries:
            title = x['t'] if len(x['t']) <= tmax else x['t'][:tmax - 1].rstrip() + '…'
            e.append({'l': x['l'], 'd': x['d'], 't': title, 'g': x['g'], 'v': x['v'], 'u': x['u'], 'n': x['n'], 'm': x['m'], 's': x['s']})
        body = json.dumps({'k': key, 't': t, 'r': r, 'chips': chips, 'e': e}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(body) <= LIMIT or tmax <= 8:
            return body
        tmax -= 6

def main():
    snap = json.load(open(sys.argv[1], encoding='utf-8'))
    out = sys.argv[2]
    prev = sys.argv[3].rstrip('/') if len(sys.argv) > 3 else ''
    os.makedirs(os.path.join(out, 'l'), exist_ok=True)
    os.makedirs(os.path.join(out, 'a'), exist_ok=True)
    pr = -1
    if prev:
        try: pr = json.loads(fetch(prev + '/meta.json'))['r']
        except Exception: pr = -1
    r = (pr + 1) % 2 if pr >= 0 else 0
    t, chips = snap['t'], snap.get('chips', [])
    lists = {}
    for k in range(CHIPS):
        lists['c%d' % k] = snap['lists'].get('c%d' % k, [])[:40]
    for i in range(10):
        pool = snap['lists'].get('l%d' % i, [])
        lists['l%d_0' % i] = pool[:40]
        lists['l%d_1' % i] = pool[40:80]
    try: font = ImageFont.truetype('DejaVuSans-Bold.ttf', 18)
    except Exception: font = ImageFont.load_default()
    # thumbnails once per channel
    uniq = {}
    for arr in lists.values():
        for e in arr: uniq.setdefault(e['l'], e)
    with cf.ThreadPoolExecutor(16) as ex:
        tiles = dict(zip(uniq.keys(), ex.map(lambda e: tile_for(e, font), uniq.values())))
    sizes = {}
    for key, arr in lists.items():
        body = pack(key, arr, t, r, chips)
        open(os.path.join(out, 'l', key + '.json'), 'wb').write(body)
        sizes[key] = len(body)
        atlas = Image.new('RGB', (CW * COLS, CH * ROWS), (20, 14, 30))
        for i, e in enumerate(arr[:COLS * ROWS]):
            atlas.paste(tiles[e['l']], ((i % COLS) * CW, (i // COLS) * CH))
        atlas.save(os.path.join(out, 'a', '%s_%d.jpg' % (key, r)), quality=72, optimize=True, progressive=False)
        # keep the previous rotation's picture for players still holding the previous list
        if prev and pr >= 0:
            try: open(os.path.join(out, 'a', '%s_%d.jpg' % (key, pr)), 'wb').write(fetch('%s/a/%s_%d.jpg' % (prev, key, pr)))
            except Exception: pass
    meta = {'t': t, 'r': r, 'mock': snap.get('mock', False), 'chips': chips, 'pg': snap.get('pg'), 'sizes': sizes}
    open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8').write(json.dumps(meta, ensure_ascii=False))
    print('rotation', r, 'max list bytes', max(sizes.values()), 'lists', len(sizes), 'channels', len(uniq))
    assert max(sizes.values()) < 7000

if __name__ == '__main__':
    main()
