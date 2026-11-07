"""Pick THE LOFT's baked Twitch channels (the top N PG channels by viewer-hours the Worker has seen).

usage: python tools/pick_baked.py [N=500]
Reads https://loft-twitch.theloft.workers.dev/baked?n=N and rewrites baked.json. Needs the owner's Twitch app
(TWITCH_CLIENT_ID/SECRET on the Worker) and ideally a few days of polling so the ranking is fair.
After this: commit + push (the site republishes baked.json), `npx wrangler deploy` in worker/ (the Worker stops giving
slots to newly baked channels), then in Unity run LoftR35Twitch.RefreshBakedChannels(), and upload the world.
"""
import json, sys, urllib.request, datetime
n = int(sys.argv[1]) if len(sys.argv) > 1 else 500
d = json.loads(urllib.request.urlopen('https://loft-twitch.theloft.workers.dev/baked?n=%d' % n, timeout=30).read())
if d.get('mock') or d.get('n', 0) < 50:
    sys.exit('Not enough real data yet (mock=%s, n=%s). Add the Twitch app secrets and let it run for a few days.' % (d.get('mock'), d.get('n')))
out = {'version': datetime.date.today().isoformat() + '-top%d' % len(d['channels']), 'note': 'top PG channels by viewer-hours', 'channels': d['channels']}
json.dump(out, open('baked.json', 'w'), indent=0)
print('baked.json:', len(d['channels']), 'channels, version', out['version'])
