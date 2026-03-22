// Inline SVG icon components for the sidebar

/** Quadcopter drone viewed from above */
export function IconDrone({ size = 20, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* center body */}
      <rect x="9" y="9" width="6" height="6" rx="2"/>
      {/* arms */}
      <line x1="9"  y1="9"  x2="5"  y2="5" />
      <line x1="15" y1="9"  x2="19" y2="5" />
      <line x1="9"  y1="15" x2="5"  y2="19"/>
      <line x1="15" y1="15" x2="19" y2="19"/>
      {/* rotor hubs */}
      <circle cx="5"  cy="5"  r="2"/>
      <circle cx="19" cy="5"  r="2"/>
      <circle cx="5"  cy="19" r="2"/>
      <circle cx="19" cy="19" r="2"/>
      {/* rotor blades (short lines through each hub) */}
      <line x1="3" y1="5"  x2="7"  y2="5"  strokeWidth="2.2"/>
      <line x1="5" y1="3"  x2="5"  y2="7"  strokeWidth="2.2"/>
      <line x1="17" y1="5"  x2="21" y2="5" strokeWidth="2.2"/>
      <line x1="19" y1="3"  x2="19" y2="7" strokeWidth="2.2"/>
      <line x1="3" y1="19" x2="7"  y2="19" strokeWidth="2.2"/>
      <line x1="5" y1="17" x2="5"  y2="21" strokeWidth="2.2"/>
      <line x1="17" y1="19" x2="21" y2="19" strokeWidth="2.2"/>
      <line x1="19" y1="17" x2="19" y2="21" strokeWidth="2.2"/>
    </svg>
  )
}

/** Drone + wifi signal = Drone Logs tab */
export function IconDroneLogs({ size = 20, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* small drone top */}
      <rect x="9" y="3" width="6" height="5" rx="1.5"/>
      <line x1="9"  y1="4" x2="6"  y2="2" />
      <line x1="15" y1="4" x2="18" y2="2" />
      <circle cx="5.5"  cy="1.8" r="1.5"/>
      <circle cx="18.5" cy="1.8" r="1.5"/>
      <line x1="4" y1="1.8" x2="7" y2="1.8" strokeWidth="2"/>
      <line x1="17" y1="1.8" x2="20" y2="1.8" strokeWidth="2"/>
      {/* wifi arcs below */}
      <path d="M7.5 13.5 a6.5 6.5 0 0 1 9 0" />
      <path d="M9.5 16   a3.5 3.5 0 0 1 5 0" />
      <circle cx="12" cy="19" r="1" fill={color} stroke="none"/>
    </svg>
  )
}

/** File with arrow out = Decrypt tab */
export function IconDecrypt({ size = 20, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* file shape */}
      <path d="M4 3 L4 21 L15 21 L15 9 L10 3 Z"/>
      <path d="M10 3 L10 9 L15 9"/>
      {/* horizontal lines on file */}
      <line x1="7" y1="13" x2="11" y2="13"/>
      <line x1="7" y1="16" x2="10" y2="16"/>
      {/* export arrow */}
      <line x1="17" y1="13" x2="23" y2="13"/>
      <polyline points="20,10 23,13 20,16"/>
    </svg>
  )
}

/** DatCon-style decrypt icon */
export function IconDatCon({ size = 20, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* brackets */}
      <path d="M4 5 H7" />
      <path d="M4 5 V19" />
      <path d="M4 19 H7" />
      <path d="M20 5 H17" />
      <path d="M20 5 V19" />
      <path d="M20 19 H17" />
      {/* center chip */}
      <rect x="8.5" y="8" width="7" height="8" rx="1.5" />
      <line x1="10" y1="10.5" x2="14" y2="10.5" />
      <line x1="10" y1="13" x2="14" y2="13" />
      <line x1="10" y1="15.5" x2="12.8" y2="15.5" />
    </svg>
  )
}

/** Large drone logo for sidebar top */
export function IconDroneLarge({ size = 30, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {/* body */}
      <rect x="11" y="11" width="10" height="10" rx="3"/>
      {/* arms */}
      <line x1="11" y1="11" x2="6"  y2="6" />
      <line x1="21" y1="11" x2="26" y2="6" />
      <line x1="11" y1="21" x2="6"  y2="26"/>
      <line x1="21" y1="21" x2="26" y2="26"/>
      {/* rotor hubs */}
      <circle cx="6"  cy="6"  r="3"/>
      <circle cx="26" cy="6"  r="3"/>
      <circle cx="6"  cy="26" r="3"/>
      <circle cx="26" cy="26" r="3"/>
      {/* rotor blades */}
      <line x1="3"  y1="6"  x2="9"  y2="6"  strokeWidth="2.8"/>
      <line x1="6"  y1="3"  x2="6"  y2="9"  strokeWidth="2.8"/>
      <line x1="23" y1="6"  x2="29" y2="6"  strokeWidth="2.8"/>
      <line x1="26" y1="3"  x2="26" y2="9"  strokeWidth="2.8"/>
      <line x1="3"  y1="26" x2="9"  y2="26" strokeWidth="2.8"/>
      <line x1="6"  y1="23" x2="6"  y2="29" strokeWidth="2.8"/>
      <line x1="23" y1="26" x2="29" y2="26" strokeWidth="2.8"/>
      <line x1="26" y1="23" x2="26" y2="29" strokeWidth="2.8"/>
      {/* center dot */}
      <circle cx="16" cy="16" r="2" fill={color} stroke="none" opacity="0.7"/>
    </svg>
  )
}

/** Serial/USB connection icon */
export function IconSerial({ size = 20, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* USB plug */}
      <rect x="8" y="2" width="8" height="4" rx="1"/>
      <rect x="10" y="6" width="4" height="12" rx="1"/>
      {/* connection lines */}
      <line x1="12" y1="18" x2="12" y2="22"/>
      <line x1="8" y1="20" x2="16" y2="20"/>
      {/* signal waves */}
      <path d="M6 14 Q8 12 10 14 Q12 16 14 14 Q16 12 18 14"/>
      <path d="M7 16 Q9 14 11 16 Q13 18 15 16 Q17 14 19 16"/>
    </svg>
  )
}
