import { useState } from 'react';

interface StudentAvatarProps {
  src?: string | null;
  name: string;
  sizeClass?: string;
}

export function StudentAvatar({ src, name, sizeClass = 'w-11 h-11 text-sm' }: StudentAvatarProps) {
  const [failed, setFailed] = useState(false);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');

  if (!src || failed) {
    return (
      <div
        aria-label={name}
        className={`${sizeClass} rounded-lg bg-slate-800/90 border border-sky-500/30 text-sky-200 font-semibold flex items-center justify-center shrink-0 select-none`}
      >
        {initials || 'ST'}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${sizeClass} rounded-lg object-cover border border-sky-500/30 bg-slate-900 shrink-0`}
    />
  );
}
