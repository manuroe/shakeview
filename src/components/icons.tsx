import type { SVGProps } from 'react';

/**
 * Small stroke icons shared across buttons. Each takes the usual SVG props
 * (size, className) and inherits `currentColor`, so it follows the button's
 * text colour. Decorative: label the button, not the icon.
 */
type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps): IconProps => ({
  width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', ...props,
});
const stroke = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Tray with an arrow up: drop or pick files. */
export function UploadIcon(props: IconProps) {
  return (
    <svg aria-hidden="true" {...base({ viewBox: '0 0 24 24', ...props })} stroke="currentColor" strokeWidth="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="17 8 12 3 7 8"></polyline>
      <line x1="12" y1="3" x2="12" y2="15"></line>
    </svg>
  );
}

/** Two sheets: copy to clipboard. */
export function CopyIcon(props: IconProps) {
  return (
    <svg aria-hidden="true" {...base(props)}>
      <rect x="5" y="4" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
      <path d="M3 11V3a1 1 0 0 1 1-1h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

/** Arrow down onto a line: save to a file. */
export function DownloadIcon(props: IconProps) {
  return (
    <svg aria-hidden="true" {...base(props)}>
      <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

/** Tick: done. */
export function CheckIcon(props: IconProps) {
  return <svg aria-hidden="true" {...base(props)}><path d="M3 8.5l3 3 7-7" {...stroke}/></svg>;
}

/** Pencil: edit. */
export function PencilIcon(props: IconProps) {
  return <svg aria-hidden="true" {...base(props)}><path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5L11 2.5zM9.5 4l2.5 2.5" {...stroke}/></svg>;
}

/** Eye: preview. */
export function EyeIcon(props: IconProps) {
  return (
    <svg aria-hidden="true" {...base(props)}>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" {...stroke}/>
      <circle cx="8" cy="8" r="2" {...stroke}/>
    </svg>
  );
}

/** Bin: forget. */
export function TrashIcon(props: IconProps) {
  return <svg aria-hidden="true" {...base(props)}><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" {...stroke}/></svg>;
}

/** Arrow left: go back. */
export function BackIcon(props: IconProps) {
  return <svg aria-hidden="true" {...base(props)}><path d="M13 8H3M7 4L3 8l4 4" {...stroke}/></svg>;
}

/** Cross: close. */
export function CloseIcon(props: IconProps) {
  return <svg aria-hidden="true" {...base(props)}><path d="M4 4l8 8M12 4l-8 8" {...stroke}/></svg>;
}

/** Key: the anonymisation salt. */
export function KeyIcon(props: IconProps) {
  return <svg aria-hidden="true" {...base(props)}><circle cx="5" cy="11" r="2.75" {...stroke}/><path d="M7 9l6-6M11 5l1.5 1.5M9.5 6.5L11 8" {...stroke}/></svg>;
}
