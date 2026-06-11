/**
 * RepoForm.tsx
 *
 * The first screen: a single input where the user pastes a GitHub repo URL and
 * clicks "Index". It's a "controlled component" — React owns the input value via
 * state, and we hand the URL up to the parent (App) when submitted.
 */
import { useState, FormEvent } from 'react';

interface Props {
  // Called with the entered URL when the form is submitted.
  onSubmit: (url: string) => void;
  // True while indexing is starting/running, so we can disable the form.
  busy: boolean;
}

export function RepoForm({ onSubmit, busy }: Props) {
  const [url, setUrl] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault(); // stop the browser's default full-page reload
    const trimmed = url.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <form className="repo-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="https://github.com/owner/repo"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy || url.trim().length === 0}>
        {busy ? 'Indexing…' : 'Index repo'}
      </button>
    </form>
  );
}
