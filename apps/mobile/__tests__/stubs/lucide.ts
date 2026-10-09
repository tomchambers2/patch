// Lucide icons stub — every icon renders a host 'Icon' node carrying its
// name + the props (size/color) so a test can assert which icon + styling a
// screen picked without needing real SVG glyphs.
import React from 'react';

function icon(name: string): (props: Record<string, unknown>) => React.ReactElement {
  const C = (props: Record<string, unknown>): React.ReactElement =>
    React.createElement('Icon', { name, ...props });
  C.displayName = name;
  return C;
}

export const AlarmClock = icon('AlarmClock');
export const AlarmClockOff = icon('AlarmClockOff');
export const Zap = icon('Zap');
export const Archive = icon('Archive');
export const Bot = icon('Bot');
export const ArchiveRestore = icon('ArchiveRestore');
export const ArrowLeft = icon('ArrowLeft');
export const ArrowUp = icon('ArrowUp');
export const Camera = icon('Camera');
export const Check = icon('Check');
export const ChevronDown = icon('ChevronDown');
export const ChevronLeft = icon('ChevronLeft');
export const ChevronRight = icon('ChevronRight');
export const ChevronUp = icon('ChevronUp');
export const Clock = icon('Clock');
export const CornerLeftUp = icon('CornerLeftUp');
export const Ear = icon('Ear');
export const ExternalLink = icon('ExternalLink');
export const Eye = icon('Eye');
export const EyeOff = icon('EyeOff');
export const FileText = icon('FileText');
export const GitFork = icon('GitFork');
export const Folder = icon('Folder');
export const FolderOpen = icon('FolderOpen');
export const File = icon('File');
export const House = icon('House');
export const SquareTerminal = icon('SquareTerminal');
export const RotateCcw = icon('RotateCcw');
export const Image = icon('Image');
export const KeyRound = icon('KeyRound');
export const ListChecks = icon('ListChecks');
export const MessageCircle = icon('MessageCircle');
export const MessageCirclePlus = icon('MessageCirclePlus');
export const MessageSquare = icon('MessageSquare');
export const Mic = icon('Mic');
export const MicOff = icon('MicOff');
export const MoreHorizontal = icon('MoreHorizontal');
export const Paperclip = icon('Paperclip');
export const Phone = icon('Phone');
export const PhoneIncoming = icon('PhoneIncoming');
export const PhoneOff = icon('PhoneOff');
export const Pin = icon('Pin');
export const Plus = icon('Plus');
export const Radio = icon('Radio');
export const Search = icon('Search');
export const Settings = icon('Settings');
export const Smartphone = icon('Smartphone');
export const Trash2 = icon('Trash2');
export const Wrench = icon('Wrench');
export const X = icon('X');
export const ClipboardList = icon('ClipboardList');
export const FilePen = icon('FilePen');
export const Lock = icon('Lock');
export const LockOpen = icon('LockOpen');
export const Sparkles = icon('Sparkles');
export const Square = icon('Square');
export const Target = icon('Target');
export const Terminal = icon('Terminal');
export const TriangleAlert = icon('TriangleAlert');
export const Bell = icon('Bell');
export const Circle = icon('Circle');
export const CircleCheck = icon('CircleCheck');
export const CircleDot = icon('CircleDot');
export const FolderSearch = icon('FolderSearch');
export const Copy = icon('Copy');
export const TextSelect = icon('TextSelect');
export const Inbox = icon('Inbox');
export const Layers = icon('Layers');
export const LayoutTemplate = icon('LayoutTemplate');
export const Minus = icon('Minus');
export const PackageOpen = icon('PackageOpen');
