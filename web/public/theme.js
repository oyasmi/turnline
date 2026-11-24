(() => {
  const key = 'turnline.theme.v1';
  const root = document.documentElement;
  const toolbarColor = document.querySelector('meta[name="theme-color"]');

  function apply(theme) {
    root.dataset.theme = theme;
    toolbarColor.content = theme === 'light' ? '#edf1ee' : '#111916';
  }

  try { apply(localStorage.getItem(key) === 'light' ? 'light' : 'dark'); }
  catch { apply('dark'); }

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('toggle-theme');
    function label() {
      const name = root.dataset.theme === 'light' ? '使用深色主题' : '使用浅色主题';
      toggle.setAttribute('aria-label', name);
      toggle.title = name;
    }
    label();
    toggle.onclick = () => {
      const theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      apply(theme);
      label();
      try { localStorage.setItem(key, theme); } catch {}
    };
  }, { once: true });
})();
