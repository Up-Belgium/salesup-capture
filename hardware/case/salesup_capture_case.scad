// ============================================================================
// salesUp Capture — prototype-behuizing (parametrisch, OpenSCAD)
// ============================================================================
// Voor het XIAO ESP32S3 Sense-prototype (zie ../README.md). Twee delen:
// een bakje + klikdeksel, met:
//  - microfoon-opening aan de bovenkant
//  - opening voor de USB-C / drukknop aan de zijkant
//  - een ronde uitsparing aan de achterkant voor een magneetring (Ø56 mm,
//    MagSafe-stijl) ZODAT het toestel op de achterkant van een telefoon klikt;
//    of laat de ring weg en gebruik een 3M-plakker op het platte vlak.
//
// Dit is een START-ontwerp om snel te kunnen printen en testen — meet je
// concrete onderdelen op en pas de variabelen hieronder aan vóór het printen.
// Render: openscad salesup_capture_case.scad  (of open in de OpenSCAD-GUI).
// ============================================================================

/* [Binnenmaten — meet je samengestelde elektronica op] */
inner_l = 38;     // lengte (mm): board + LiPo naast elkaar
inner_w = 26;     // breedte (mm)
inner_h = 12;     // hoogte (mm): board + batterij gestapeld
wall    = 2.0;    // wanddikte
lid_h   = 3.0;    // dekselhoogte

/* [Openingen] */
mic_d      = 3.5;             // microfoongaatje (boven)
usb_w      = 10; usb_h = 5;   // USB-C / knop-opening (zijkant)

/* [Magneetring achterkant] */
use_magnet_ring = true;
ring_outer = 56;   // MagSafe-ring buitendiameter
ring_inner = 42;   // binnendiameter
ring_depth = 1.8;  // diepte van de uitsparing (ring + dunne plak)

$fn = 64;
ol = inner_l + 2*wall;   // buitenmaten
ow = inner_w + 2*wall;
oh = inner_h + wall;     // bodem + zijwanden (deksel apart)

module shell() {
  difference() {
    // massieve buitenvorm met afgeronde hoeken
    minkowski() { cube([ol-4, ow-4, oh-2], center=true); cylinder(r=2, h=2, center=true); }
    // holte
    translate([0,0,wall/2]) cube([inner_l, inner_w, inner_h+2], center=true);
    // microfoon boven
    translate([0,0,oh/2]) cylinder(d=mic_d, h=wall*3, center=true);
    // USB/knop zijkant
    translate([ol/2, 0, -oh/4 + wall]) cube([wall*4, usb_w, usb_h], center=true);
    // magneetring-uitsparing in de bodem
    if (use_magnet_ring)
      translate([0,0,-oh/2 + ring_depth/2])
        difference() {
          cylinder(d=ring_outer, h=ring_depth+0.1, center=true);
          cylinder(d=ring_inner, h=ring_depth+0.2, center=true);
        }
  }
}

module lid() {
  translate([0, ow + 6, 0]) {
    difference() {
      minkowski() { cube([ol-4, ow-4, lid_h-2], center=true); cylinder(r=2, h=2, center=true); }
      // klikrand (lip die in de holte valt)
      translate([0,0,lid_h/2]) cube([inner_l-0.4, inner_w-0.4, lid_h], center=true);
    }
    // ventilatie/microfoon-doorvoer ook in deksel-zijde optioneel
  }
}

shell();
lid();
