#!/bin/sh
# index.html = snapshot of the real Patch web UI (base.html) + this design's overlay
cd "$(dirname "$0")"
python3 - <<'P'
b=open('base.html').read()
css=open('overlay.css').read(); js=open('overlay.js').read()
i=b.rindex('</body>')
open('index.html','w').write(b[:i]+'<style>'+css+'</style><script>'+js+'</script>'+b[i:])
P
