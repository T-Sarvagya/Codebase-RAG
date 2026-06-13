/**
 * ThemeToggle.tsx
 *
 * A round icon button that flips between light and dark. The actual theme value
 * lives in App (so the rest of the UI can react to it); this component just
 * shows the right icon and calls back on click. The icon shown is the theme you
 * will switch TO — a sun while you're in dark mode, a moon while you're in light.
 */
type Theme = 'light' | 'dark';

interface Props {
  theme: Theme;
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: Props) {
  const goingToLight = theme === 'dark';
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      aria-label={goingToLight ? 'Switch to light theme' : 'Switch to dark theme'}
      title={goingToLight ? 'Light mode' : 'Dark mode'}
    >
      {goingToLight ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
