// Nachbau des Kilanka-Leistungsnachweises (Typst) fuer Tests.
// Layout-Varianten fuer die Summenzeilen ueber "variant":
//   "muster"  – Direkte / Indirekte / Gesamt wie im Layoutvorschlag (leere, farbige Felder)
//   "summe"   – "Summe" bleibt, darunter Indirekte Stunden gesamt + Gesamtstunden (leer)
//   "gefuellt"– wie "muster", aber alle Werte bereits eingetragen
//   "alt"     – heutiger Stand: nur "Summe"

#let doc = json(sys.inputs.at("data", default: "data.json"))
#let mit_unterschrift = doc.at("unterschrift", default: true)

#let grau = rgb("#d3d3d3")
#let gruen = rgb("#eaf3e6")
#let blau = rgb("#e9f0fa")
#let grau2 = rgb("#dcdcdc")

#set page(
  paper: "a4",
  margin: (left: 1cm, right: 1cm, top: 1cm, bottom: 2.2cm),
  footer: context [
    #set text(size: 7.5pt, weight: "light")
    #grid(
      columns: (1fr, auto),
      align: (left + bottom, right + bottom),
      [SynoFacio UG \ Heinrich-Hertz-Str. 18-32a \ 25336 Elmshorn],
      [Seite #counter(page).display() von #counter(page).final().first()],
    )
  ],
)
#set text(font: "Lato", size: 9pt, lang: "de")
#set par(leading: 0.45em)

#let sb(body) = text(weight: "semibold", body)
#let lt(body) = text(weight: "light", body)

#let nachweis(n) = [
  #grid(
    columns: (1fr, auto),
    align: (left + top, right + top),
    text(size: 12pt)[Stundennachweis Fachleistungsstunden],
    image("logo.jpg", width: 79.7pt),
  )
  #v(4pt)
  #table(
    columns: (1fr, 1fr, 1fr, 1fr),
    stroke: 0.5pt,
    inset: 4pt,
    fill: (x, y) => if calc.even(x) { grau },
    sb[Junger Mensch:], lt[#n.name], sb[Aktenzeichen WiHi], lt[#n.at("az", default: "")],
    sb[Leistungszeitraum:], lt[#n.zeitraum], sb[Name Sachbearbeiter ASD], lt[],
    sb[Bewilligte Std. im \ Leistungszeitraum:], lt[#n.bewilligt Stunden], sb[Betreuende Fachkraft:], lt[#n.fachkraft],
  )
  #v(4pt)
  #let rows = n.rows.map(r => (
    lt[#r.tag],
    table.cell(align: right, lt[#r.zeit]),
    lt[#r.std],
    table.cell(align: right, lt[#r.inhalt]),
    table.cell(align: right, lt[#r.at("bem", default: "")]),
  )).flatten()
  #let variante = doc.variant
  #let summen = if variante == "alt" {(
    table.cell(colspan: 2, align: right, sb[Summe]), sb[#n.direkt], table.cell(colspan: 2)[],
  )} else if variante == "summe" {(
    table.cell(colspan: 2, align: right, sb[Summe]), sb[#n.direkt], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, sb[Indirekte Stunden gesamt]), [], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, sb[Gesamtstunden]), [], table.cell(colspan: 2)[],
  )} else if variante == "strich" {(
    table.cell(colspan: 2, align: right, sb[Direkte Stunden gesamt]), sb[#n.direkt], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, sb[Indirekte Stunden gesamt]), sb[–], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, sb[Gesamtstunden]), sb[–], table.cell(colspan: 2)[],
  )} else if variante == "labels2" {(
    table.cell(colspan: 2, align: right, sb[Summe direkte Stunden:]), sb[#n.direkt], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, sb[Indirekte Zeit:]), [], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, sb[Gesamtstundenanzahl:]), [], table.cell(colspan: 2)[],
  )} else if variante == "frei" {(
    table.cell(colspan: 2, align: right, sb[Summe]), sb[#n.direkt], table.cell(colspan: 2)[],
  )} else {(
    table.cell(colspan: 2, align: right, sb[Direkte Stunden gesamt]), sb[#n.direkt], table.cell(colspan: 2)[],
    table.cell(colspan: 2, align: right, fill: gruen, sb[Indirekte Stunden gesamt]),
      table.cell(fill: blau, if variante == "gefuellt" { sb[#n.indirekt] } else { [] }),
      table.cell(colspan: 2, fill: gruen)[],
    table.cell(colspan: 2, align: right, fill: grau2, sb[Gesamtstunden]),
      table.cell(fill: blau, if variante == "gefuellt" { sb[#n.gesamt] } else { [] }),
      table.cell(colspan: 2, fill: grau2)[],
  )}
  #table(
    columns: (94.25pt, 94.25pt, 67.32pt, 168.31pt, 114.45pt),
    stroke: 0.5pt,
    inset: 4pt,
    table.header(
      table.cell(fill: grau, sb[Tag]),
      table.cell(fill: grau, sb[Zeitbereich]),
      table.cell(fill: grau, sb[Stunden]),
      table.cell(fill: grau, sb[Inhalt Tätigkeit / Bemerkung (z.B. Kontakt zu ...\[JM, Mutter,...\]..., Krisengespräch, Elterngespräch)]),
      table.cell(fill: grau, sb[Bemerkung]),
    ),
    ..rows,
    ..summen,
  )
  #if variante == "frei" [
    #v(10pt)
    #grid(columns: (130pt, 80pt), row-gutter: 8pt,
      sb[Indirekte Stunden gesamt:], lt[\_\_\_\_\_\_\_\_\_\_],
      sb[Gesamtstunden:], lt[\_\_\_\_\_\_\_\_\_\_],
    )
  ]
  #v(14pt)
  #if mit_unterschrift [#align(right)[
    #box(width: 113.4pt)[
      #align(center)[
        #image("sig.png", width: 49.6pt)
        #v(-6pt)
        #line(length: 113.4pt, stroke: 0.5pt)
        #v(-4pt)
        #lt[die Richtigkeit bestätigt: \ Fachkraft:]
      ]
    ]
  ]]
]

#for (i, n) in doc.nachweise.enumerate() {
  if i > 0 { pagebreak() }
  nachweis(n)
}
