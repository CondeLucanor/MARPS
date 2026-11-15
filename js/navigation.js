/**
 * MAЯPS — sidebar navigation between the five sections.
 * Section ids map to HTML elements: id "map" -> <section id="section-map">.
 */
import { appState } from './state.js';
import { emit, EVENTS } from './events.js';

const ICONS = {
  'mission-view': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  'map': '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  'mission-log': '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  'mission-archive': '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  'mission-setup': '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'
};

export const SECTIONS = [
  { id: 'mission-view', label: 'Mission View' },
  { id: 'map', label: 'Map' },
  { id: 'mission-log', label: 'Mission Log' },
  { id: 'mission-archive', label: 'Mission Archive' },
  { id: 'mission-setup', label: 'Mission Setup' }
];

export function initNavigation() {
  const nav = document.getElementById('sidebar-nav');
  if (!nav) return;

  nav.innerHTML = '';
  for (const section of SECTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.section = section.id;
    button.innerHTML =
      `<span class="nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[section.id]}</svg></span>` +
      `<span class="nav-label">${section.label}</span>`;
    button.addEventListener('click', () => navigateTo(section.id));
    nav.appendChild(button);
  }

  showSection(appState.currentSection);
}

function showSection(sectionId) {
  for (const section of SECTIONS) {
    const element = document.getElementById(`section-${section.id}`);
    if (element) element.classList.toggle('active', section.id === sectionId);
  }
  document.querySelectorAll('.nav-item').forEach((button) => {
    const isActive = button.dataset.section === sectionId;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

/** Shows a section and announces the change. Returns false if the id is unknown. */
export function navigateTo(sectionId) {
  if (!SECTIONS.some((s) => s.id === sectionId)) {
    console.error(`[MAЯPS] Unknown section: ${sectionId}`);
    return false;
  }
  const previous = appState.currentSection;
  appState.currentSection = sectionId;
  showSection(sectionId);
  emit(EVENTS.SECTION_CHANGED, { section: sectionId, previous });
  return true;
}