import type { ColorValue } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export function Icon({ name, color, size = 22 }: { name: "clock" | "schedule" | "setup"; color: ColorValue; size?: number }) {
  const common = { stroke: color, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "clock" && (
        <>
          <Circle cx={12} cy={12} r={9} {...common} />
          <Path d="M12 7v5l3 2" {...common} />
        </>
      )}
      {name === "schedule" && (
        <>
          <Rect x={3.5} y={5} width={17} height={15} rx={2} {...common} />
          <Path d="M3.5 10h17M8 3v4M16 3v4" {...common} />
        </>
      )}
      {name === "setup" && (
        <>
          <Path d="M4 7h10M18 7h2M4 17h2M10 17h10" {...common} />
          <Circle cx={16} cy={7} r={2} {...common} />
          <Circle cx={8} cy={17} r={2} {...common} />
        </>
      )}
    </Svg>
  );
}
