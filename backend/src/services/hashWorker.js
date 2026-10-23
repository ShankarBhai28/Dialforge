// Worker thread for the bulk user import: bcrypt-hashes a list of passwords
// (same cost as Create user) off the main thread, so live screens and call
// handling don't stall while hundreds of accounts are made.
const { parentPort, workerData } = require('worker_threads');
const bcrypt = require('bcryptjs');

(async () => {
  const hashes = [];
  for (const pw of workerData.passwords) hashes.push(await bcrypt.hash(pw, 10));
  parentPort.postMessage(hashes);
})();
