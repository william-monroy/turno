# @claudio/fonts

MesloLGS Nerd Font (Regular, Bold, Italic, Bold Italic) from Nerd Fonts 3.4.0: Meslo LG
patched with the Nerd Fonts icons, drawn full size (they spill into the space the status line
leaves after each icon). The claudio status line draws its
icons with it, and `claudio ui install` copies these files into your user font folder.

It is the same Nerd Fonts release Orca ships for its terminal, and Orca draws the icons at the
same full size, so the status line looks the same in Orca and in any terminal set to this font.
The `Mono` variant shrinks every icon to one cell and looks noticeably smaller. Older Nerd Fonts (2.x,
such as the MesloLGS NF that powerlevel10k recommends) draw several icons differently.

The files are byte for byte the ones in
[ryanoasis/nerd-fonts v3.4.0](https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/Meslo/S);
`index.js` pins their SHA-256 checksums, and `claudio ui install` checks them before copying.

## License

Meslo LG is Copyright 2009, 2010, 2013 André Berg, under the Apache License 2.0. The Nerd Fonts
icons and patcher are under the SIL Open Font License 1.1 and the MIT License. Both texts are in
[LICENSE.txt](LICENSE.txt). The fonts keep their own licenses; the rest of claudio is MIT.
