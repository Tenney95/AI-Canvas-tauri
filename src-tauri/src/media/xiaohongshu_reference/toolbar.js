(() => {
  const button = document.getElementById('import-button');
  const status = document.querySelector('.status');
  button.addEventListener('click', (event) => {
    if (event.isTrusted && !button.disabled) location.assign('/import');
  });
  addEventListener('dragover', (event) => event.preventDefault());
  addEventListener('drop', (event) => event.preventDefault());
  window.setXhsToolbarStatus = (state) => {
    const importing = state.status === 'importing';
    button.disabled = importing;
    button.setAttribute('aria-busy', String(importing));
    button.textContent = state.label;
    status.textContent = state.message;
    status.title = state.message;
  };
})();
