import asyncio, json, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
SRC="/home/claude/bingers-extension/extension"; EXT=tempfile.mkdtemp()+"/ext"; shutil.copytree(SRC,EXT)
cfg=open(EXT+"/lib/config.js").read().replace('"https://api.bingers.app/v1"','"http://127.0.0.1:8768/v1"'); open(EXT+"/lib/config.js","w").write(cfg)
# Simulate the user having approved "all websites": grant the wildcards up front, and let the
# engine treat granted wildcards as tracked (in the real build they come from optional permissions).
m=json.load(open(EXT+"/manifest.json")); m["host_permissions"]+=["http://127.0.0.1:8768/*","https://*/*","http://*/*"]; json.dump(m,open(EXT+"/manifest.json","w"))
tb=open(EXT+"/lib/tracker-bg.js").read().replace("...(m.host_permissions || []), ","...(m.host_permissions || []).filter((o) => !o.includes('*/*') || o.startsWith('https://api')).filter(o=>!['https://*/*','http://*/*'].includes(o)), "); open(EXT+"/lib/tracker-bg.js","w").write(tb)
LOG="/home/claude/e2e/api2.log"; open(LOG,"w").close()
api=subprocess.Popen([sys.executable,"mockapi.py",LOG]); site=subprocess.Popen([sys.executable,"-m","http.server","8767","-d","site"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
async def play(ctx, url, secs=12):
    p=await ctx.new_page(); await p.goto(url)
    for _ in range(secs*2):
        await p.wait_for_timeout(500)
        if await p.evaluate("document.getElementById('v').ended"): break
    await p.wait_for_timeout(1500); return p
async def main():
    async with async_playwright() as p:
        ctx=await p.chromium.launch_persistent_context(tempfile.mkdtemp(),executable_path="/usr/bin/google-chrome",headless=True,
            args=[f"--disable-extensions-except={EXT}",f"--load-extension={EXT}","--disable-features=DisableLoadExtensionCommandLineSwitch","--no-sandbox","--autoplay-policy=no-user-gesture-required"],viewport={"width":1100,"height":620})
        sw=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        ext_id=sw.url.split("/")[2]
        await sw.evaluate("async()=>{await chrome.storage.local.set({auth:{mode:'pat',token:'bng_pat_test'}}); await chrome.storage.sync.set({minMinutes:0.1});}")
        print("tracked:", await sw.evaluate("async()=>{ const o=(await chrome.permissions.getAll()).origins; return o }"))
        await sw.evaluate("async()=>{ await new Promise(r=>chrome.runtime.onMessage.hasListeners()?r():r()); }")
        opts=await ctx.new_page(); await opts.goto(f"chrome-extension://{ext_id}/options/options.html"); await opts.wait_for_timeout(300)
        regs=await opts.evaluate("()=>new Promise(r=>chrome.runtime.sendMessage({type:'syncTracker'},r))")
        print("syncTracker ->", regs)
        await play(ctx,"http://localhost:8767/watch.html")
        n1=sum(1 for l in open(LOG) if "/scrobble/stop" in l); print("all-sites: stop calls =", n1)
        await sw.evaluate("chrome.storage.sync.set({excludedHosts:['localhost']})")
        await opts.reload(); await opts.wait_for_timeout(800)
        print("all-sites checkbox:", await opts.is_checked("#all-sites"), "| site grid hidden:", await opts.evaluate("document.getElementById('sites').hidden"), "| excluded:", await opts.inner_text("#excluded"))
        await opts.screenshot(path="/home/claude/e2e/options-all.png", full_page=True)
        await play(ctx,"http://localhost:8767/watch.html")
        n2=sum(1 for l in open(LOG) if "/scrobble/stop" in l); print("after skipping localhost: stop calls =", n2)
        await ctx.close()
asyncio.run(main()); api.terminate(); site.terminate()
