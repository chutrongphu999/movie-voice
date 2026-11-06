// One local Vietnamese OCR worker, reused between frames.
const { createWorker, PSM } = require('tesseract.js');
const readline = require('readline');
const path = require('path');

(async () => {
  const worker = await createWorker('vie', 1, {
    langPath: path.join(__dirname, '..', 'models'), gzip: false,
    cachePath: path.join(__dirname, '..', 'models'), logger: () => {},
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
  for await (const line of readline.createInterface({ input: process.stdin })) {
    try {
      const { image } = JSON.parse(line);
      const { data } = await worker.recognize(Buffer.from(image, 'base64'));
      const words = (data.words || []).filter(word => /\p{L}/u.test(word.text));
      const worstWordConfidence = words.length ? Math.min(...words.map(word => word.confidence)) : 0;
      process.stdout.write(JSON.stringify({ text: data.text, confidence: data.confidence, worstWordConfidence }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    }
  }
  await worker.terminate();
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
