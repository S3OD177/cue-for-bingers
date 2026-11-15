import asyncio, json, os, shutil, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright
SRC="/home/claude/bingers-extension/extension"; EXT=tempfile.mkdtemp()+"/ext"; shutil.copytree(SRC,EXT)
# test build: point API at the mock and pre-grant the test site
cfg=open(EXT+"/lib/config.js").read().replace('"https://api.bingers.app/v1"','"http://127.0.0.1:8768/v1"'); open(EXT+"/lib/config.js","w").write(cfg)
m=json.load(open(EXT+"/manifest.json")); m["host_permissions"]+=["http://127.0.0.1:8768/*","http://localhost:8767/*"]; json.dump(m,open(EXT+"/manifest.json","w"))
LOG="/home/claude/e2e/api.log"; open(LOG,"w").close()
api=subprocess.Popen([sys.executable,"mockapi.py",LOG]); site=subprocess.Popen([sys.executable,"-m","http.server","8767","-d","site"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
async def main():
    async with async_playwright() as p:
        ctx=await p.chromium.launch_persistent_context(tempfile.mkdtemp(),executable_path="/usr/bin/google-chrome",headless=True,
            args=[f"--disable-extensions-except={EXT}",f"--load-extension={EXT}","--disable-features=DisableLoadExtensionCommandLineSwitch","--no-sandbox","--autoplay-policy=no-user-gesture-required"],viewport={"width":1100,"height":620})
        sw=ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        ext_id=sw.url.split("/")[2]
        await sw.evaluate("""async()=>{await chrome.storage.local.set({auth:{mode:'pat',token:'bng_pat_test'}});
          await chrome.storage.sync.set({minMinutes:0.1}); }""")
        # trackedOrigins filters api.bingers.app only; mock API origin must not get the tracker either, harmless
        regs=await sw.evaluate("""async()=>{ const o=(await chrome.permissions.getAll()).origins; 
            await chrome.scripting.unregisterContentScripts().catch(()=>{});
            await chrome.scripting.registerContentScripts([{id:'cue-tracker',matches:['http://localhost:8767/*'],js:['lib/parse.js','content/tracker.js'],allFrames:true,runAt:'document_idle'}]);
            return {origins:o, regs:(await chrome.scripting.getRegisteredContentScripts()).map(r=>r.matches)} }""")
        print("registered:", regs)
        page=await ctx.new_page(); errs=[]
        page.on("pageerror",lambda e:errs.append(str(e)))
        await page.goto("http://localhost:8767/watch.html")
        shot_taken=False
        for i in range(40):
            await page.wait_for_timeout(500)
            prog=await page.evaluate("v=document.getElementById('v'); Math.round(v.currentTime/v.duration*100)")
            if not shot_taken and prog>30:
                await page.screenshot(path="/home/claude/e2e/toast-tracking.png"); shot_taken=True
            if prog>=99: break
        await page.wait_for_timeout(1500)
        await page.screenshot(path="/home/claude/e2e/toast-watched.png")
        # click Undo in the closed shadow root via keyboard-free approach: find by coordinates from screenshot is brittle,
        # so use the same message the button sends
        sid=(await sw.evaluate("chrome.storage.session.get('nowPlaying')"))["nowPlaying"]
        sid=list(sid.values())[0]["sessionId"]
        opts=await ctx.new_page(); await opts.goto(f"chrome-extension://{ext_id}/options/options.html"); await opts.wait_for_timeout(500)
        r=await opts.evaluate("""(sid)=>new Promise(res=>chrome.runtime.sendMessage({type:'trackerAction',payload:{sessionId:sid,action:'undo'}},res))""", sid)
        print("undo ->", r["data"]["state"] if r.get("ok") else r)
        await opts.screenshot(path="/home/claude/e2e/options.png", full_page=True)
        # unknown title flow
        p2=await ctx.new_page(); p2.on("pageerror",lambda e:errs.append(str(e)))
        await p2.goto("http://localhost:8767/unknown.html"); await p2.wait_for_timeout(4500)
        np=(await sw.evaluate("chrome.storage.session.get('nowPlaying')"))["nowPlaying"]
        u=[v for v in np.values() if v["state"]=="unknown"]
        print("unknown session:", u[0]["state"] if u else np)
        if u:
            r=await opts.evaluate("""(sid)=>new Promise(res=>chrome.runtime.sendMessage({type:'trackerAction',payload:{sessionId:sid,action:'link',titleId:'sev-id'}},res))""", u[0]["sessionId"])
            print("link ->", r.get("data",{}).get("state"), r.get("data",{}).get("label"), r.get("error"))
        for i in range(30):
            await p2.wait_for_timeout(500)
            if await p2.evaluate("v=document.getElementById('v'); v.ended"): break
        await p2.wait_for_timeout(1500)
        np=(await sw.evaluate("chrome.storage.session.get('nowPlaying')"))["nowPlaying"]
        print("after link + play:", [(v["label"], v["state"]) for v in np.values()])
        np=await sw.evaluate("chrome.storage.session.get('nowPlaying')")
        print("nowPlaying:", json.dumps(np)[:400])
        # popup with now playing, opened as a tab pointing at the video tab is hard; read state instead
        print("page errors:", errs or "none")
        await ctx.close()
asyncio.run(main())
api.terminate(); site.terminate()
for l in open(LOG): 
    d=json.loads(l); print(d["m"], d["p"], d["b"] if d["b"] else "")
