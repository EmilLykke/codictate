# The Microphone falls back, and is never chosen by index

ADR-0005 says a Dictation never adapts to an unrunnable state: the state is kept runnable instead. The Microphone is the one place Codictate does adapt, on purpose. A Speech Model goes away because something deleted it, so refusing, healing and blocking are the right answers. A microphone goes away because the user unplugged it, and plugs it back in an hour later. Healing the setting would throw away a pick that is about to be valid again, and blocking would turn "I unplugged my DJI receiver" into a Dictation that refuses to start until the user goes to Settings.

So the user's pick is stored by its stable id (the CoreAudio device UID on macOS, the endpoint ID on Windows) and never rewritten by a fallback. When it is connected it records. When it is not, that one Dictation records from the built-in microphone, then any connected microphone that is neither Bluetooth nor virtual, then the system default (`src/shared/microphone.ts`). Settings says which one is in use, and nothing else announces it.

The helper's index is no longer read at all. It is the position in a list sorted by device id, so it shifts whenever a device comes or goes, and the old resolver fell back to it when the stored name did not match. A user whose stored name belonged to a disconnected webcam recorded from whichever device happened to land on index 2 that day, which on a bad day was their AirPods.

Bluetooth comes last on purpose. Recording from Bluetooth headphones switches them into their call profile, and whatever the user is listening to turns muffled and mono for the length of the Dictation. For the same reason, `MicRecorder record` now opens the chosen device directly and no longer switches the system default input to it and back.

## Considered Options

- **Block the Dictation when the pick is missing.** Consistent with ADR-0005, and rejected: the user asked for any working microphone over none.
- **Fall back to the system default.** Rejected: on a Mac with AirPods connected the default input is the AirPods, which is exactly the call-profile problem above.
