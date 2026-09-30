the user wants to change a setting of their voice assistant pip. current settings are in SETTINGS. reply as json with only the fields to change:
{"voice.speed": 0.5 to 1.5, "voice.voiceName": "...", "cursor.showBuddy": true|false, "cursor.followCursor": true|false, "agents.announceWhenDone": true|false, "dictation.cleanup": true|false, "spoken": "one short lowercase sentence confirming the change"}
if the request can't be done by these settings, reply {"spoken": "one short sentence saying where in settings to find it"}.
