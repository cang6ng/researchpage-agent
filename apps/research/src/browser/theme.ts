/**
 * The ResearchPage Mantine theme.
 *
 * Mantine owns the interaction primitives — buttons, inputs, selects, menus,
 * popovers, dialogs, drawers, skeletons — and this file is how they stop
 * looking like Mantine's defaults and start looking like this product: one
 * brand ink, one radius scale, one control height, tabular numerals where
 * numbers are read.
 *
 * The document renderer is deliberately *not* themed here. A report is not
 * application UI, and its typography belongs to the artifact, not to Mantine.
 */

import { createTheme, type MantineColorsTuple } from "@mantine/core";

/** The brand: a quiet ink blue, ten shades so Mantine's variants have a scale. */
const ink: MantineColorsTuple = [
  "#eaf1f4",
  "#d8e5ec",
  "#b6cddb",
  "#90b2c6",
  "#6f9bb3",
  "#5a8ca6",
  "#4a7f9a",
  "#3a6a84",
  "#2b536b",
  "#244b60",
];

const verified: MantineColorsTuple = [
  "#eaf4ef",
  "#d7e9e0",
  "#b2d3c2",
  "#8abca3",
  "#69a98a",
  "#559d7b",
  "#4a9572",
  "#3c7f60",
  "#32705a",
  "#285a45",
];

const limited: MantineColorsTuple = [
  "#fff4df",
  "#f7e8cd",
  "#e9d1a5",
  "#dab97a",
  "#cda659",
  "#c39a45",
  "#bd9439",
  "#a67f2b",
  "#94651c",
  "#7f5409",
];

const conflict: MantineColorsTuple = [
  "#f3edfa",
  "#e4dbf2",
  "#c7b6e2",
  "#a98ed0",
  "#926fc2",
  "#835bba",
  "#7b51b6",
  "#6a42a0",
  "#74569a",
  "#4f2f77",
];

const danger: MantineColorsTuple = [
  "#fbedea",
  "#f0d9d6",
  "#dfb1ad",
  "#ce8782",
  "#c0655f",
  "#b8524c",
  "#ad4742",
  "#9a3833",
  "#8a2f2b",
  "#79231f",
];

export const researchTheme = createTheme({
  colors: { ink, verified, limited, conflict, danger },
  primaryColor: "ink",
  primaryShade: { light: 9 },

  fontFamily:
    '"Inter", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
  fontFamilyMonospace: 'ui-monospace, "Cascadia Mono", "SF Mono", "Segoe UI Mono", Consolas, monospace',
  headings: {
    fontFamily:
      '"Inter", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
    fontWeight: "600",
  },

  fontSizes: {
    xs: "11px",
    sm: "12.5px",
    md: "14px",
    lg: "15px",
    xl: "20px",
  },
  lineHeights: {
    xs: "1.45",
    sm: "1.5",
    md: "1.55",
    lg: "1.6",
    xl: "1.3",
  },

  radius: {
    xs: "4px",
    sm: "6px",
    md: "8px",
    lg: "10px",
    xl: "14px",
  },
  defaultRadius: "md",

  spacing: {
    xs: "6px",
    sm: "10px",
    md: "16px",
    lg: "24px",
    xl: "36px",
  },

  shadows: {
    xs: "0 1px 2px rgba(20,32,38,0.035)",
    sm: "0 2px 10px rgba(20,32,38,0.045)",
    md: "0 14px 36px rgba(20,32,38,0.10)",
    lg: "0 14px 36px rgba(20,32,38,0.10)",
    xl: "0 14px 36px rgba(20,32,38,0.10)",
  },

  focusRing: "auto",
  cursorType: "pointer",

  components: {
    Button: {
      defaultProps: { size: "sm", radius: "md", fw: 500 },
      styles: { root: { letterSpacing: "0.005em" } },
    },
    ActionIcon: {
      defaultProps: { variant: "subtle", color: "ink", size: "md", radius: "md" },
    },
    TextInput: { defaultProps: { size: "sm", radius: "md" } },
    Textarea: { defaultProps: { size: "sm", radius: "md" } },
    Select: { defaultProps: { size: "sm", radius: "md" } },
    SegmentedControl: {
      defaultProps: { size: "xs", radius: "md" },
    },
    Tooltip: {
      defaultProps: {
        openDelay: 260,
        withArrow: false,
        radius: "sm",
        fz: "12px",
        px: "8px",
        py: "5px",
      },
    },
    Menu: {
      defaultProps: { radius: "lg", shadow: "md", withinPortal: true },
    },
    Popover: {
      defaultProps: { radius: "lg", shadow: "md", withinPortal: true },
    },
    Modal: {
      defaultProps: { radius: "xl", shadow: "md", centered: true, overlayProps: { backgroundOpacity: 0.3, blur: 2 } },
    },
    Drawer: {
      defaultProps: { radius: 0, shadow: "md", overlayProps: { backgroundOpacity: 0.3, blur: 2 } },
    },
    Skeleton: {
      defaultProps: { radius: "sm" },
    },
    ScrollArea: {
      defaultProps: { scrollbarSize: 8, type: "hover" },
    },
    Notification: {
      defaultProps: { radius: "lg" },
    },
  },
});
