'use strict';
// Popup for File Blinders for GitHub — reads and writes exactly one storage key
// ("markTestsViewedMode"). No network access, no other extension APIs.

const MODE_KEY = 'markTestsViewedMode';
const groups = [...document.querySelectorAll('.grp')];

function render(mode) {
  groups.forEach((group) => {
    const input = group.querySelector('input[type="radio"]');
    input.checked = input.value === mode;
    group.classList.toggle('on', input.checked);
  });
}

browser.storage.local.get(MODE_KEY).then((stored) => {
  render(stored[MODE_KEY] === 'hide-implementation' ? 'hide-implementation' : 'hide-tests');
});

groups.forEach((group) => {
  group.addEventListener('change', () => {
    browser.storage.local.set({ [MODE_KEY]: group.querySelector('input[type="radio"]').value });
  });
});
