// Lucide-style thin icons drawn with currentColor
const S = ({ size = 18, children, ...p }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    {children}
  </svg>
);

export const Select = (p) => (
  <S {...p}>
    <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
  </S>
);
export const Arrow = (p) => (
  <S {...p}>
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="8 7 17 7 17 16" />
  </S>
);
export const Text = (p) => (
  <S {...p}>
    <path d="M4 7V4h16v3" />
    <path d="M9 20h6" />
    <path d="M12 4v16" />
  </S>
);
export const Shape = (p) => (
  <S {...p}>
    <rect x="3" y="3" width="13" height="13" rx="2" />
    <path d="M9 16a6 6 0 0 0 6 6 6 6 0 0 0 6-6 6 6 0 0 0-6-6" />
  </S>
);
export const Pen = (p) => (
  <S {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </S>
);
export const Blur = (p) => (
  <S {...p}>
    <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5 12 2.5C11.5 5 10 7.4 8 9.5 6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
  </S>
);
export const Crop = (p) => (
  <S {...p}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </S>
);
export const Undo = (p) => (
  <S {...p}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </S>
);
export const Redo = (p) => (
  <S {...p}>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
  </S>
);
export const Plus = (p) => (
  <S {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </S>
);
export const Minus = (p) => (
  <S {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </S>
);
export const Copy = (p) => (
  <S {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </S>
);
export const Download = (p) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </S>
);
export const Link = (p) => (
  <S {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </S>
);
export const Upload = (p) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </S>
);
export const Check = (p) => (
  <S {...p}>
    <polyline points="20 6 9 17 4 12" />
  </S>
);
export const X = (p) => (
  <S {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </S>
);

export const Background = (p) => (
  <S {...p}>
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 17l10 5 10-5" />
    <path d="M2 12l10 5 10-5" />
  </S>
);

export const ChevronDown = (p) => (
  <S {...p}>
    <polyline points="6 9 12 15 18 9" />
  </S>
);

export const AlignLeft = (p) => (
  <S {...p}>
    <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>
  </S>
);
export const AlignCenter = (p) => (
  <S {...p}>
    <line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
  </S>
);
export const AlignRight = (p) => (
  <S {...p}>
    <line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>
  </S>
);
export const AlignTop = (p) => (
  <S {...p}>
    <line x1="3" y1="3" x2="21" y2="3"/>
    <line x1="12" y1="7" x2="12" y2="21"/>
    <polyline points="8 11 12 7 16 11"/>
  </S>
);
export const AlignMiddleV = (p) => (
  <S {...p}>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="12" y1="3" x2="12" y2="8"/>
    <line x1="12" y1="16" x2="12" y2="21"/>
    <polyline points="8 6 12 3 16 6"/>
    <polyline points="8 18 12 21 16 18"/>
  </S>
);
export const AlignBottom = (p) => (
  <S {...p}>
    <line x1="3" y1="21" x2="21" y2="21"/>
    <line x1="12" y1="3" x2="12" y2="17"/>
    <polyline points="8 13 12 17 16 13"/>
  </S>
);
export const Lock = (p) => (
  <S {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </S>
);
export const Unlock = (p) => (
  <S {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
  </S>
);
export const Maximize2 = (p) => (
  <S {...p}>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </S>
);

// File with a download arrow — used for "copy & save".
export const CopySave = (p) => (
  <S {...p}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M12 11v7" />
    <polyline points="9.5 15.5 12 18 14.5 15.5" />
  </S>
);

// Cloud with an upload arrow — used for "upload to Drive".
export const DriveCopy = (p) => (
  <S {...p}>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    <polyline points="8 13 12 9 16 13" />
    <line x1="12" y1="9" x2="12" y2="21" />
  </S>
);

export const ExternalLink = (p) => (
  <S {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </S>
);

