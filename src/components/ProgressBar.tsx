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

  // Determine gradient based on percentage
  const getGradient = () => {
    if (percentage < 25) {
      return "bg-gradient-to-r from-danger to-danger/60";
    }
    if (percentage < 75) {
      return "bg-gradient-to-r from-warning to-caution";
    }
    return "bg-gradient-to-r from-success to-info";
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
      <div
        className={`w-full rounded-full overflow-hidden ${getHeight()}`}
        style={{ backgroundColor: "var(--border-dim)" }}
      >
        <div
          className={`${getGradient()} ${getHeight()} rounded-full transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <div className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          {percentage.toFixed(0)}% complete
        </div>
      )}
    </div>
  );
}
