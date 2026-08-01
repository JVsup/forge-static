(() => {
  const grid = document.querySelector('[data-card-grid]');
  if (grid) {
    const cards = [...grid.querySelectorAll('[data-archive-card]')];
    const controls = Object.fromEntries([...document.querySelectorAll('[data-filter]')].map((element) => [element.dataset.filter, element]));
    const count = document.querySelector('[data-result-count]');
    const noResults = document.querySelector('[data-no-results]');
    const apply = () => {
      const query = (controls.search?.value || '').trim().toLowerCase();
      const spt = controls.spt?.value || '';
      const category = controls.category?.value || '';
      const flag = controls.flag?.value || '';
      let visible = 0;
      for (const card of cards) {
        const matchesQuery = !query || card.dataset.search.includes(query);
        const matchesSpt = !spt || card.dataset.spt.split(',').includes(spt);
        const matchesCategory = !category || card.dataset.category === category;
        const matchesFlag = !flag || card.dataset[flag] === 'yes';
        card.hidden = !(matchesQuery && matchesSpt && matchesCategory && matchesFlag);
        if (!card.hidden) visible += 1;
      }
      const sort = controls.sort?.value || 'name';
      cards.sort((a, b) => {
        if (sort === 'downloads') return Number(b.dataset.downloads) - Number(a.dataset.downloads);
        if (sort === 'updated') return String(b.dataset.updated).localeCompare(String(a.dataset.updated));
        return a.dataset.name.localeCompare(b.dataset.name);
      }).forEach((card) => grid.append(card));
      if (count) count.textContent = new Intl.NumberFormat('en-GB').format(visible);
      if (noResults) noResults.hidden = visible !== 0;
    };
    Object.values(controls).forEach((control) => control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', apply));
  }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  if (tabs.length) {
    const activate = (tab, updateHash = true) => {
      for (const candidate of tabs) {
        const selected = candidate === tab;
        candidate.setAttribute('aria-selected', String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(candidate.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      }
      if (updateHash) history.replaceState(null, '', tab.hash);
      tab.focus({ preventScroll: true });
    };
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', (event) => { event.preventDefault(); activate(tab); });
      tab.addEventListener('keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowLeft: -1, Home: -index, End: tabs.length - 1 - index };
        if (!(event.key in keys)) return;
        event.preventDefault();
        activate(tabs[(index + keys[event.key] + tabs.length) % tabs.length]);
      });
    }
    const initial = tabs.find((tab) => tab.hash === location.hash) || tabs[0];
    activate(initial, false);
    addEventListener('hashchange', () => {
      const target = tabs.find((tab) => tab.hash === location.hash);
      if (target) activate(target, false);
    });
  }
})();

