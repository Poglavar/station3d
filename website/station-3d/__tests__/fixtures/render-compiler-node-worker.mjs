// Run the production module Worker under Node so state acknowledgement and
// transferable-buffer ownership can be tested across a real thread boundary.
import { parentPort, workerData } from 'node:worker_threads';
globalThis.postMessage = (message, transfer = []) => parentPort.postMessage(message, transfer);
await import(workerData?.moduleUrl || '../../workers/render-compiler-worker.js');
parentPort.on('message', data => globalThis.onmessage({ data }));
