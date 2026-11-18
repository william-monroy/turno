# turno-fonts

**The font the turno status line draws its icons with.** You do not install it yourself:
`turno ui install` copies these files into your user font folder and can set the font in your
terminal.

![The turno status line with Nerd Font icons and with Unicode icons](https://raw.githubusercontent.com/wimo-dev/turno/main/docs/assets/statusline.png)

```sh
turno ui install                     # the font, and the status line in Claude Code
turno ui install --terminal current  # also set the font in this terminal
```

Without the font the status line still works: it falls back to Unicode icons. More about the
status line at [turno.wimo.dev](https://turno.wimo.dev/docs/concepts/profiles#the-status-line),
and what each version changed in [Releases](https://turno.wimo.dev/docs/releases).

## What is in it

MesloLGS Nerd Font (Regular, Bold, Italic, Bold Italic) from Nerd Fonts 3.4.0: Meslo LG
patched with the Nerd Fonts icons, drawn full size (they spill into the space the status line
leaves after each icon).

It is the same Nerd Fonts release Orca ships for its terminal, and Orca draws the icons at the
same full size, so the status line looks the same in Orca and in any terminal set to this font.
The `Mono` variant shrinks every icon to one cell and looks noticeably smaller. Older Nerd Fonts (2.x,
such as the MesloLGS NF that powerlevel10k recommends) draw several icons differently.

The files are byte for byte the ones in
[ryanoasis/nerd-fonts v3.4.0](https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/Meslo/S);
`index.js` pins their SHA-256 checksums, and `turno ui install` checks them before copying.

## License

Meslo LG is Copyright 2009, 2010, 2013 André Berg, under the Apache License 2.0. The Nerd Fonts
icons and patcher are under the SIL Open Font License 1.1 and the MIT License. Both texts are in
[LICENSE.txt](LICENSE.txt). The fonts keep their own licenses; the rest of turno is under the Apache License 2.0.
