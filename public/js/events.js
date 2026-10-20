// Live changes from the server for one book (server-sent events). The
// browser reconnects by itself; `onReconnect` runs after a gap, since changes
// made while disconnected were missed.
export function connectEvents(bookId, { onBatch, onReconnect, onStatus = () => {} }) {
  if (typeof EventSource === 'undefined') return { close() {} };
  const source = new EventSource(`/api/books/${encodeURIComponent(bookId)}/events`);
  let dropped = false;
  source.onmessage = (e) => {
    try {
      onBatch(JSON.parse(e.data));
    } catch (err) {
      console.error('Bad event', err);
    }
  };
  source.onerror = () => {
    dropped = true;
    onStatus(false);
  };
  source.onopen = () => {
    onStatus(true);
    if (dropped) {
      dropped = false;
      onReconnect();
    }
  };
  return { close: () => source.close() };
}
