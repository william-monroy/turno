// The font files and their checksums. Plain JavaScript on purpose: this package has no build.
import { fileURLToPath } from "node:url";

export const FAMILY = "MesloLGS Nerd Font";

/** Nerd Fonts release the files come from; `url` is where each one is published. */
export const VERSION = "3.4.0";

const UPSTREAM = `https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v${VERSION}/patched-fonts/Meslo/S/`;

export const FONTS = [
  {
    file: "MesloLGSNerdFont-Regular.ttf",
    url: `${UPSTREAM}Regular/MesloLGSNerdFont-Regular.ttf`,
    sha256: "44ae9b687639c1529ecd01e5d0ae8d98f3b30cb20b02bbe4e6d9fb474c8dee36",
  },
  {
    file: "MesloLGSNerdFont-Bold.ttf",
    url: `${UPSTREAM}Bold/MesloLGSNerdFont-Bold.ttf`,
    sha256: "9799788a96066045c3f53f2e5bcbe376c6b9adb9514e3276cc84ac42d8b176d0",
  },
  {
    file: "MesloLGSNerdFont-Italic.ttf",
    url: `${UPSTREAM}Italic/MesloLGSNerdFont-Italic.ttf`,
    sha256: "3dede17df16e62abdae99ea7f13a14cbc391e2cc9429c8dfa1b5349e78758e9c",
  },
  {
    file: "MesloLGSNerdFont-BoldItalic.ttf",
    url: `${UPSTREAM}Bold-Italic/MesloLGSNerdFont-BoldItalic.ttf`,
    sha256: "734956444bc02c8ea0e7f7effe46c616f2e492734c6afe91049e4735d522542c",
  },
];

export const fontsDir = fileURLToPath(new URL("./fonts/", import.meta.url));
