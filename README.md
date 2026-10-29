# Breego

Nettapp for Breego-kjølebokser (A22, A30, A40, A50). Den styrer boksen direkte over Bluetooth fra Chrome på Android eller datamaskin. iPhone støtter ikke Bluetooth fra nettsider, så der kommer appen senere i App Store.

## Slik tester du

1. Åpne adressen i **Chrome på en Android-telefon**.
2. Slå på kjøleboksen og stå ved siden av den.
3. Trykk **Finn kjøleboksen** og velg boksen i listen. Den heter «SimpleBLEPeripheral» eller «Intelligent Refrigerator».
4. Vil du ha appen på hjemskjermen, trykker du på menyen ⋮ i Chrome og velger **Legg til på startskjermen**.

Svarer ikke boksen, åpner du **Innstillinger → Feilsøking**. Der ser du alt som sendes til og fra boksen, og du kan bytte linjeslutt. Trykk **Kopier loggen** og send teksten til utvikleren.

Uten boks kan du trykke **Prøv demoen uten boks**.

## Teknisk

- Ren HTML, CSS og JavaScript uten byggesteg. GitHub Pages serverer filene direkte.
- Protokoll: Tefu «Intelligent Vehicle Refrigerator» V1.1.x. Service `FFF0`, skriv på `FFF1`, varsler på `FFF4`. Kommandoer som `/S03/1/+04`, svar som `/S00/...`.
- `js/protocol.js`: kommandoer og tolking av statuslinjer.
- `js/transports.js`: ekte Bluetooth og en simulert boks til demoen.
- `js/fridge.js`: kø for kommandoer, finner riktig linjeslutt, kobler til igjen og lagrer logg.
- `js/app.js`: skjermene.
- Tester: `node --test tests/*.test.mjs`

Ikke bekreftet ennå (venter på leverandøren): spenningen for batterivern, hvordan binding fungerer, og hvilken typekode A22 sender.
