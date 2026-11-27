import { Camera } from 'lucide-react';
import { useRef } from 'react';
import { useTouch } from '../lib/media';

/**
 * "Take a photo" on phones and tablets: opens the camera straight away instead of the file
 * picker. Hidden on computers, where the normal file picker is enough.
 */
export function TakePhoto({
  onFile,
  disabled,
  label = 'Take a photo',
  className = 'btn btn-secondary',
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const touch = useTouch();
  const input = useRef<HTMLInputElement>(null);
  if (!touch) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Camera size={16} aria-hidden /> {label}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/*"
        capture="environment"
        aria-label={label}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}
