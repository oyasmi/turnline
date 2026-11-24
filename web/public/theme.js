(() => {
  const key = 'turnline.theme.v1';
  const root = document.documentElement;
  const toolbarColor = document.querySelector('meta[name="theme-color"]');

  function apply(theme) {
    root.dataset.theme = theme;
    const active = root.hasAttribute('data-in-call');
    toolbarColor.content = theme === 'light' ? active ? '#f2e5ef' : '#f9f2ef' : active ? '#24192f' : '#17131f';
  }

  const preferred = matchMedia('(prefers-color-scheme: light)');
  let selected;
  try { selected = localStorage.getItem(key); } catch {}
  const update = () => apply(selected || (preferred.matches ? 'light' : 'dark'));
  update();
  preferred.addEventListener('change', update);
  new MutationObserver(update).observe(root, { attributeFilter: ['data-in-call'] });

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('toggle-theme');
    function label() {
      const name = root.dataset.theme === 'light' ? '使用深色主题' : '使用浅色主题';
      toggle.setAttribute('aria-label', name);
      toggle.title = name;
    }
    label();
    preferred.addEventListener('change', label);
    toggle.onclick = () => {
      const theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      selected = theme;
      apply(theme);
      label();
      try { localStorage.setItem(key, theme); } catch {}
    };
  }, { once: true });
})();
