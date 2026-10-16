type PuffLogoProps = {
  className?: string;
  /** Accessible name. When omitted the mark is treated as decorative. */
  label?: string;
  style?: import('react').CSSProperties;
};

const GREEN = '#00d492';
const INK = '#0c121f';

const legs = (
  <g fill="none" stroke={GREEN} strokeWidth={13} strokeLinecap="round">
    <path d="M38 78 C 26 92 28 106 42 108" />
    <path d="M60 84 L60 108" />
    <path d="M82 78 C 94 92 92 106 78 108" />
  </g>
);

const body = (
  <path
    d="M60 12 C 86 12 102 30 102 54 C 102 74 86 86 60 86 C 34 86 18 74 18 54 C 18 30 34 12 60 12 Z"
    fill={GREEN}
  />
);

const face = (
  <>
    <ellipse cx="49" cy="51" rx="6.5" ry="8.5" fill={INK} />
    <ellipse cx="71" cy="51" rx="6.5" ry="8.5" fill={INK} />
    <circle cx="51.5" cy="47.5" r="2.6" fill="#fff" />
    <circle cx="73.5" cy="47.5" r="2.6" fill="#fff" />
    <path d="M53 65 Q60 72 67 65" fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" />
  </>
);

/** Just the puff: used where space is tight (app chrome, avatars). */
export function PuffMark({ className, label, style }: PuffLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="10 0 100 120"
      className={className}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {legs}
      {body}
      {face}
    </svg>
  );
}

/** The full lock-up: mark + lowercase wordmark. */
export function PuffLogo({ className, label }: PuffLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 330 120"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {legs}
      {body}
      {face}
      <text
        x="122"
        y="84"
        fill="#eef0f8"
        fontSize={74}
        fontWeight={700}
        letterSpacing="-1"
        style={{
          fontFamily:
            'var(--font-display), var(--font-sans), ui-sans-serif, system-ui, sans-serif',
        }}
      >
        puff
      </text>
    </svg>
  );
}
