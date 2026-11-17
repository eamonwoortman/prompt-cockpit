// index.html's only module script. Picks the page before anything else runs,
// so the Superagent tab never evaluates app.js and its session bootstrap
// (rejoin, ?attach=, the launcher's resumable list) never fires there.
const view = new URL(location.href).searchParams.get('view');

if (view === 'superagent') {
  document.body.classList.add('view-superagent');
  const { initSuperagentView } = await import('/superagent-view.js');
  initSuperagentView();
} else {
  await import('/app.js');
}
