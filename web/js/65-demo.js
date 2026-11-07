// Clearsky page: the demo (`clearsky try`) says so in the menu, with a way out.
// The server joins web/js/*.js in name order into one script in index.html, so they share one scope.

if (document.querySelector('meta[name=demo]')) {
  const b = document.createElement('div');
  b.className = 'demo-badge';
  b.innerHTML = '<span title="Made-up data: nothing here is real, and nothing of yours is read">Demo data</span><button type="button" id="demo-leave">Leave demo</button>';
  $('#side').prepend(b);
  document.title = `${document.title} (demo)`;
  $('#demo-leave').onclick = async () => {
    try { await post('/api/demo/stop', {}); } catch { /* it stops anyway */ }
    document.body.innerHTML = '<div class="demo-left"><h1>The demo has stopped</h1><p>Its made-up data is gone. You can close this tab.</p><p><a href="http://127.0.0.1:7777/">Open your own Clearsky</a></p></div>';
  };
}
