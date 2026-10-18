const openDB = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('parallel-reader', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export async function storage(action, value) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('documents', action === 'getAll' || action === 'get' ? 'readonly' : 'readwrite');
      const request = transaction.objectStore('documents')[action](value);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Local storage transaction aborted.'));
    });
  } finally { db.close(); }
}
