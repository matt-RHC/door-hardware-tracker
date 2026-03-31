interface ProgressBarProps {
  value: number;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

export default function ProgressBar({
  value,
  size = "md",
  showLabel = false,
}: ProgressBarProps) {
  // Clamp value between 0 and 100
  const percentage = Math.max(0, Math.min(100, value));

  // Determine color based on percentage
  const getColor = () => {
    if (percentage < 25) return "bg-red-600";
    if (percentage < 75) return "bg-yellow-500";
    return "bg-green-600";
  };

  // Determine height based on size
  const getHeight = () => {
    switch (size) {
      case "sm":
        return "h-2";
      case "lg":
        return "h-4";
      default:
        return "h-3";
    }
  };

  return (
    <div>
      <div className={`w-full bg-slate-800 rounded-full overflow-hidden ${getHeight()}`}>
        <div
          className={`${getColor()} ${getHeight()} rounded-full transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <div className="mt-2 text-sm text-slate-400">
          {percentage.toFixed(0)}% complete
        </div>
      )}
    </div>
  );
}
