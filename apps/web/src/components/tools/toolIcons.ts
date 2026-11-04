import {
  ArrowDownUp,
  Combine,
  Crop,
  EyeOff,
  File as FileIcon,
  FileImage,
  FileOutput,
  FileText,
  FileType2,
  Film,
  Hash,
  Images,
  Lock,
  LockOpen,
  Minimize2,
  Music,
  Repeat,
  RotateCw,
  Scaling,
  Scissors,
  SlidersHorizontal,
  Stamp,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

/** Icon names come from the backend catalog; unknown names fall back to a plain file icon. */
const ICONS: Record<string, LucideIcon> = {
  ArrowDownUp,
  Combine,
  Crop,
  EyeOff,
  FileImage,
  FileOutput,
  FileText,
  FileType2,
  Film,
  Hash,
  Images,
  Lock,
  LockOpen,
  Minimize2,
  Music,
  Repeat,
  RotateCw,
  Scaling,
  Scissors,
  SlidersHorizontal,
  Stamp,
  Trash2,
};

export function toolIcon(name: string): LucideIcon {
  return ICONS[name] ?? FileIcon;
}

export const CATEGORY_LABELS: Record<string, string> = { pdf: 'PDF', word: 'Word', image: 'Images', video: 'Video' };

/** Soft accent per category so the grid is scannable without relying on colour alone (labels stay). */
export const CATEGORY_TONE: Record<string, string> = {
  pdf: 'bg-danger-soft text-danger',
  word: 'bg-info-soft text-info',
  image: 'bg-ok-soft text-ok',
  video: 'bg-warn-soft text-warn',
};
