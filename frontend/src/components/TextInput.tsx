interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

export function TextInput({
  value,
  onChange,
  disabled,
}: TextInputProps) {
  return (
    <div className="text-input">
      <textarea
        className="text-input__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Paste or type your text here..."
        rows={10}
      />
      <div className="text-input__count">
        {value.length} characters
      </div>
    </div>
  );
}
