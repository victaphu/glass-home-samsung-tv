# Installing Glass Home on a Samsung TV

These are the steps that worked on a 2023 Samsung QLED (Q70C) running Tizen 8,
from an Apple Silicon Mac. Menu names can differ a little on other models and
years. Allow about an hour the first time.

You need:

- the TV and the computer on the same home network
- a free [Samsung account](https://account.samsung.com/)
- macOS with [Node.js 22](https://nodejs.org/) and Git (Samsung's tools also
  exist for Windows and Linux, but these steps were only run on a Mac)

## 1. Turn on Developer Mode

1. On the TV: **Home**, then the **Apps** tab, scroll to the bottom, open
   **App Settings**.
2. Type **1 2 3 4 5** on the remote's number keys (or the on-screen number pad).
3. Set **Developer mode** to **On**, enter your computer's IP address as
   **Host PC IP**, and choose **OK**.
4. Restart the TV: hold the power button until it turns off, then turn it on.

Find your computer's IP on a Mac with `ipconfig getifaddr en0` (or `en1`).

## 2. Install Samsung's Tizen SDK (command-line version)

```sh
curl -fLO https://download.tizen.org/sdk/Installer/tizen-sdk_10.0/web-cli_Tizen_SDK_10.0_macos-64.bin
chmod +x web-cli_Tizen_SDK_10.0_macos-64.bin
./web-cli_Tizen_SDK_10.0_macos-64.bin --show-license      # read Samsung's licence
./web-cli_Tizen_SDK_10.0_macos-64.bin --accept-license ~/tizen-studio
```

- About 330 MB. It installs to `~/tizen-studio` and needs no admin password.
- Its tools are Intel-only; on Apple Silicon they run under Rosetta 2
  (`softwareupdate --install-rosetta` if you don't have it).
- The installer leaves a copy of itself in `/tmp/tizensdk_*`; delete it after.
- You don't need Samsung's "TV extension" or Tizen Studio.

## 3. Get Samsung's certificate tool

Samsung publishes an open-source command-line tool for making the TV
certificate:

```sh
git clone https://github.com/Samsung/tizen-agent-skills ~/tizen-agent-skills
git -C ~/tizen-agent-skills checkout 06f07eca4ce44985be1c2944d58466a82eb15692   # the version these steps were tested with
node ~/tizen-agent-skills/tizen-sdk-skills/common/lib/cli/sdk-init-cli.js ~/tizen-studio
```

## 4. Fill in your settings

```sh
git clone https://github.com/victaphu/glass-home-samsung-tv.git glass-home && cd glass-home
cp scripts/tizen-env.example.sh scripts/tizen-env.sh
```

Edit `scripts/tizen-env.sh`: your TV's IP address (`TV_IP`; it's under
**Settings > Connection > Network > Network Status > IP Settings**), a profile
name, and `SKILLS`: the `tizen-sdk-skills` folder *inside* your
`tizen-agent-skills` clone (the example assumes `~/tizen-agent-skills`). The
file is git-ignored.

## 5. Connect and read your TV's device ID

```sh
. scripts/tizen-env.sh
sdb connect "$TV"
sdb -s "$TV" shell 0 getduid
```

`sdb connect` should say `connected`. The last command prints the TV's device
ID (DUID), something like `ABCDEFGHIJ123`. Put it in `scripts/tizen-env.sh` as
`DUID=` and source the file again.

## 6. Make your Samsung certificate

A plain Tizen developer certificate won't install on recent Samsung TVs; you
need a Samsung one listing your TV's device ID. It's free.

```sh
. scripts/tizen-env.sh
mkdir -p ~/.glass-home-secrets && chmod 700 ~/.glass-home-secrets
(umask 077; printf 'TIZEN_CERTIFICATE_PASSWORD=%sAa1\n' "$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | cut -c1-20)" > ~/.glass-home-secrets/cert-password.env)

node "$CERTCLI" generate-samsung-author --profile-name "$PROFILE" --identity "Glass Home" --country <your 2-letter country code> --password-file ~/.glass-home-secrets/cert-password.env
node "$CERTCLI" generate-samsung-distributor --profile-name "$PROFILE" --duid-list "$DUID" --privilege Public --password-file ~/.glass-home-secrets/cert-password.env
```

- The first command opens a Samsung account sign-in in your browser and waits
  up to 5 minutes. The second reuses that sign-in.
- The certificates land in `~/tizen-studio-data/keystore/samsung/<profile>/`
  and are valid for one year. The passwords go into your macOS Keychain.
- **Back up `author.p12` and the password file.** Every update to the app must
  be signed with the same author certificate.

Register them so the `tizen` command can sign with them:

```sh
cp "$CA_DIR/vd_tizen_dev_public2.crt" "$CERT_DIR/"
PW="$(sed -n 's/^TIZEN_CERTIFICATE_PASSWORD=//p' ~/.glass-home-secrets/cert-password.env)"
tizen security-profiles add -n "$PROFILE" -A -a "$CERT_DIR/author.p12" -p "$PW" \
  -d "$CERT_DIR/distributor.p12" -dp "$PW" -dc "$CERT_DIR/vd_tizen_dev_public2.crt"
unset PW
tizen cli-config "profiles.path=$TIZEN_DATA/profile/profiles.xml"
```

(The `tizen` command takes the password as an argument, so it's briefly
visible to other processes on your Mac while it runs.)

## 7. Choose your options

Edit [`app/js/config.js`](../app/js/config.js): your apps, weather location
(find coordinates at
`https://geocoding-api.open-meteo.com/v1/search?name=YOUR+TOWN`), date format,
screensaver and evening dimming. The README lists them.

To see the dock apps' real Tizen IDs on your TV:

```sh
sdb -s "$TV" shell 0 vd_applist | grep -E "app_title|app_tizen_id"
```

## 8. Build and install

```sh
scripts/build.sh      # makes dist/GlassHome.wgt (and this checkout's key, first time)
scripts/install.sh    # installs it on the TV and opens it
```

`install.sh` also runs `tizen install-permit` each time, which copies a small
permission file to the TV. Installing over an existing copy keeps your photos
and shortcuts; deleting the app deletes them.

For a smaller package, omit the bundled photos without deleting the originals:

```sh
scripts/build.sh --without-bundled-photos
scripts/install.sh
```

Uploaded photos still work when the photo service is enabled. With no photos
available, the app shows its background gradient.

## 9. Make it the screen the TV starts on

On the TV:

1. **Apps** tab > **App Settings** > **Glass Home** > **Add to Home**. Move it
   to the front of the row with Left, then OK.
2. **Settings > All Settings > General & Privacy > Start Screen Options**:
   turn **Start with Smart Hub Home** off and **Autorun Last App** on. (On
   Tizen 9 / One UI this moved to **Advanced Features**.)
3. Open Glass Home, then turn the TV off and on. It should start in Glass Home.

If you ever land on Samsung's Home screen, Glass Home is the first tile in the
row (**Down, Down, OK** from Home on the tested TV).

## 10. Turn Developer Mode off again

Same place as step 1: **Apps > App Settings > 1 2 3 4 5 > Developer mode Off >
OK**, then restart the TV. Glass Home keeps working; turn Developer Mode back on
only to install an update.

## Removing it

**Apps > App Settings > Glass Home > Delete** (this also deletes uploaded
photos; your originals stay on your phone). Turn **Autorun Last App** off if
you like. To remove Samsung's tools from your Mac: delete `~/tizen-studio`,
`~/tizen-studio-data`, `~/.package-manager`, `~/.tizen` and
`~/.tizen.sdk.path.config`, and the two `certificate-manager` items in your
login Keychain.

## Troubleshooting

- **`sdb connect` fails:** Developer Mode isn't on, the Host PC IP doesn't
  match your computer's address, or the TV wasn't restarted after turning it on.
- **Install says the certificate or device ID is wrong:** check that the
  `DUID` in your distributor certificate matches `sdb shell 0 getduid`, and that
  `tizen security-profiles list` shows your profile as active.
- **Installation fails, including error 116:** check the TV's available storage
  in its Apps or storage settings (menu names vary by model). An installation
  needs space for the package and temporary installation files. On a 2018
  UN55NU6900 with about 2 MB free, the roughly 5.4 MB package failed with error
  116; omitting the bundled photos allowed it to install (see
  [issue #6](https://github.com/victaphu/glass-home-samsung-tv/issues/6)). Try
  `scripts/build.sh --without-bundled-photos`, then `scripts/install.sh`.
  Error 116 can have other causes; also check the certificate advice above.
- **The photo website doesn't answer:** open Glass Home once (it starts the
  website), and make sure your phone is on the same network, not a guest Wi-Fi.
- **An app in the dock is missing:** it isn't installed, or its ID differs on
  your TV; add the right ID from `vd_applist` to `ids` in `app/js/config.js`.
