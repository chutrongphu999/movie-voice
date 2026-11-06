const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const calls = [];
const context = {
  chrome: {
    runtime: { onMessage: {addListener() {}} },
    webNavigation: {async getFrame({frameId}) { return {parentFrameId:frameId-1, url:`https://frame${frameId}.test/`}; }},
    tabs: {async sendMessage(tabId, message, options) {
      calls.push({tabId,message,options});
      return {ok:true,crop:{...message.crop,x:message.crop.x+100,y:message.crop.y+50},dpr:2};
    }}
  },
};
vm.runInNewContext(fs.readFileSync('extension/background.js','utf8') + '\nthis.mapCrop = mapCaptureCrop;',context);
(async () => {
  const result = await context.mapCrop({frameId:2,tab:{id:5}},{x:10,y:20,w:300,h:60},1);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{x:420,y:240,w:600,h:120});
  assert.deepEqual(calls.map(c=>c.options.frameId),[1,0]);
  assert(calls.every(c=>c.tabId===5));
  console.log('PASS: nested iframe crop offsets and top-level device pixel ratio');
})().catch(error=>{console.error(error);process.exitCode=1;});
