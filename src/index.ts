import { program, Option } from "commander";
import { AttachmentBuilder, EmbedBuilder, WebhookClient } from 'discord.js';
import { F1LiveTimingClient } from "./client";
import { ArchiveLiveTiming, LiveTimingData } from "./type";
import { transcribeAudio } from "./utils";
import { promises as fs } from "fs";
import throat from "throat";

const limiter = throat(5);

const showArchiveStatus = async (whClient: WebhookClient, ltClient: F1LiveTimingClient, timestamp?: string) => {
  const as = ltClient.Current.ArchiveStatus as LiveTimingData.ArchiveStatus | undefined;

  if (!as)
    return;

  const embed = new EmbedBuilder()
    .setTitle("Archive Status")
    .addFields([
      { name: "Status", value: as.Status },
    ])
    .setTimestamp(timestamp ? new Date(timestamp) : new Date())
    .setColor("#0099ff");

  await whClient.send({
    username: 'Archive Status Bot',
    avatarURL: 'https://i.imgur.com/AfFp7pu.png',
    embeds: [embed]
  });
};

const showSessionInfo = async (whClient: WebhookClient, ltClient: F1LiveTimingClient, timestamp?: string) => {
  const si = ltClient.Current.SessionInfo as LiveTimingData.SessionInfo | undefined;

  if (!si)
    return;

  let embed = new EmbedBuilder()
    .setTitle("Session Info")
    .addFields([
      { name: "Meeting Name", value: si.Meeting.Name },
    ])

  if (si.Meeting.OfficialName)
    embed = embed
      .addFields([
        { name: "Official Name", value: si.Meeting.OfficialName },
      ]);

  embed = embed
    .addFields([
      { name: "Location", value: si.Meeting.Location },
      { name: "Country", value: `${si.Meeting.Country.Name} (${si.Meeting.Country.Code})` },
      { name: "Circuit", value: si.Meeting.Circuit.ShortName },
      { name: "Session Name", value: si.Name },
      { name: "Start Date", value: si.StartDate },
      { name: "End Date", value: si.EndDate },
    ])
    .setTimestamp(timestamp ? new Date(timestamp) : new Date())
    .setColor("#0099ff");

  await whClient.send({
    username: 'Session Info Bot',
    avatarURL: 'https://i.imgur.com/AfFp7pu.png',
    embeds: [embed]
  });
};

const showWeatherData = async (whClient: WebhookClient, ltClient: F1LiveTimingClient, timestamp?: string) => {
  const wd = ltClient.Current.WeatherData as LiveTimingData.WeatherData | undefined;

  if (!wd)
    return;

  const embed = new EmbedBuilder()
  .setTitle("Weather Data")
  .addFields([
    { name: "Air Temperature", value: `${wd.AirTemp}°C` },
    { name: "Track Temperature", value: `${wd.TrackTemp}°C` },
    { name: "Humidity", value: `${wd.Humidity}%` },
    { name: "Pressure", value: `${wd.Pressure}hPa` },
    { name: "Rainfall", value: `${wd.Rainfall === "0" ? "No" : "Yes"}` },
    { name: "Wind Direction", value: `${wd.WindDirection}°` },
    { name: "Wind Speed", value: `${wd.WindSpeed}m/s` },
  ])
  .setTimestamp(timestamp ? new Date(timestamp) : new Date())
  .setColor("#0099ff");

  await whClient.send({
    username: 'Weather Data Bot',
    avatarURL: 'https://i.imgur.com/AfFp7pu.png',
    embeds: [embed]
  });
};

const showAudioStreams = async (whClient: WebhookClient, ltClient: F1LiveTimingClient, timestamp?: string) => {
  const as = ltClient.Current.AudioStreams as LiveTimingData.AudioStreams | undefined;

  if (!as || !as.Streams.length)
    return;

  const embeds = as.Streams.map((stream) => {
    let embed = new EmbedBuilder()
      .setTitle(stream.Name)
      .addFields([
        { name: "Language", value: stream.Language },
      ]);

    if (stream.Path) {
      const si = ltClient.Current.SessionInfo as LiveTimingData.SessionInfo | undefined;
      if (si && si.Path)
        embed = embed
          .addFields([
            { name: "Path", value: `https://livetiming.formula1.com/static/${si.Path}${stream.Path}` },
          ]);
      else
        embed = embed
          .addFields([
            { name: "Path", value: stream.Path },
          ]);
    }

    embed = embed
      .setURL(stream.Uri)
      .setTimestamp(timestamp ? new Date(timestamp) : new Date())
      .setColor("#0099ff");

    return embed;
  });

  await whClient.send({
    username: 'Audio Streams Bot',
    avatarURL: 'https://i.imgur.com/AfFp7pu.png',
    embeds: embeds
  });
};

const showContentStreams = async (whClient: WebhookClient, ltClient: F1LiveTimingClient, timestamp?: string) => {
  const cs = ltClient.Current.ContentStreams as LiveTimingData.ContentStreams | undefined;

  if (!cs || !cs.Streams.length)
    return;

  const embeds = cs.Streams.map((stream) => {
    let embed = new EmbedBuilder()
      .setTitle(stream.Name)
      .addFields([
        { name: "Type", value: stream.Type },
        { name: "Language", value: stream.Language },
      ]);

    if (stream.Path) {
      const si = ltClient.Current.SessionInfo as LiveTimingData.SessionInfo | undefined;
      if (si && si.Path)
        embed = embed
          .addFields([
            { name: "Path", value: `https://livetiming.formula1.com/static/${si.Path}${stream.Path}` },
          ]);
      else
        embed = embed
          .addFields([
            { name: "Path", value: stream.Path },
          ]);
    }

    embed = embed
      .setURL(stream.Uri)
      .setTimestamp(timestamp ? new Date(timestamp) : new Date())
      .setColor("#0099ff");

    return embed;
  });

  await whClient.send({
    username: 'Content Streams Bot',
    avatarURL: 'https://i.imgur.com/AfFp7pu.png',
    embeds: embeds
  });
};

const showTeamRadio = async (whClient: WebhookClient, ltClient: F1LiveTimingClient, timestamp?: string) => {
  if (!ltClient.Current.SessionInfo || !ltClient.Current.TeamRadio)
    throw new Error("SessionInfo or TeamRadio not available");

  const si = ltClient.Current.SessionInfo as LiveTimingData.SessionInfo;
  const tr = ltClient.Current.TeamRadio as LiveTimingData.TeamRadio;
  const dl = ltClient.Current.DriverList as LiveTimingData.DriverList | undefined;

  const lastCapture = tr.Captures[tr.Captures.length - 1];

  const audioRes = await fetch(`https://livetiming.formula1.com/static/${si.Path}${lastCapture.Path}`);

  if (audioRes.status !== 200)
    throw new Error(`Failed to fetch audio from ${si.Path}${lastCapture.Path}`);

  const filename = lastCapture.Path.split('/').pop();

  if (!filename)
    throw new Error(`Failed to get filename from ${lastCapture.Path}`);

  const audioBlob = await audioRes.blob();
  const transcribedAudio = await transcribeAudio(audioBlob, filename); 

  let embed = new EmbedBuilder();

  if (dl) {
    const driver = dl[lastCapture.RacingNumber];

    embed = embed
      .setImage(driver.HeadshotUrl)
      .setTitle(`Team Radio from ${driver.FirstName} ${driver.LastName} (${driver.Tla})`);
  } else
    embed = embed
      .setTitle(`Team Radio from #${lastCapture.RacingNumber}`);

  embed = embed
    .setTimestamp(timestamp ? new Date(timestamp) : new Date(lastCapture.Utc))
    .setDescription(transcribedAudio.replace(/\n/g, ' ').trim());

  const attachment = new AttachmentBuilder(Buffer.from(await audioBlob.arrayBuffer()))
    .setName(filename);

  await whClient.send({
    username: 'Team Radio Bot',
    avatarURL: 'https://i.imgur.com/AfFp7pu.png',
    embeds: [embed],
    files: [attachment],
  });
};

program
  .command("subscribe-for-embeds")
  .addOption(
    new Option("-t, --topics <topics...>")
      .choices([
        "SessionInfo",
        "ArchiveStatus",
        "ContentStreams",
        "WeatherData",
        "CarData.z",
        "Position.z",
        "TeamRadio",
        "DriverList",
        "TrackStatus",
        "SessionData",
        "AudioStreams",
        "TyreStintSeries",
        "ExtrapolatedClock",
        "ChampionshipPrediction",
        "LapCount",
        "DriverRaceInfo",
        "TimingDataF1",
        "LapSeries",
        "TimingData",
        "TopThree",
        "TimingAppData",
        "TimingStats",
        "SessionStatus",
        "Heartbeat",
        "WeatherDataSeries",
        "CurrentTyres",
        "TlaRcm",
        "RaceControlMessages",
      ])
      .makeOptionMandatory()
  )
  .argument("<id>", "Webhook ID")
  .argument("<token>", "Webhook Token")
  .action(async (id: string, token: string, options: { topics: string[] }) => {
    const webhookClient = new WebhookClient({ id, token });
    const ltClient = new F1LiveTimingClient();

    ltClient.on("connected", async () => {
      console.log("Connected to F1 Live Timing");
      await ltClient.Subscribe(options.topics);

      if (options.topics.includes("WeatherData") && ltClient.Current.WeatherData)
        await showWeatherData(webhookClient, ltClient);

      if (options.topics.includes("SessionInfo") && ltClient.Current.SessionInfo)
        await showSessionInfo(webhookClient, ltClient);

      if (options.topics.includes("ArchiveStatus") && ltClient.Current.ArchiveStatus)
        await showArchiveStatus(webhookClient, ltClient);

      if (options.topics.includes("ContentStreams") && ltClient.Current.ContentStreams)
        await showContentStreams(webhookClient, ltClient);

      if (options.topics.includes("AudioStreams") && ltClient.Current.AudioStreams)
        await showAudioStreams(webhookClient, ltClient);
    });

    ltClient.on("disconnected", async (reason) => {
      console.log("Disconnected from F1 Live Timing", reason);
    });

    ltClient.on("error", async (err) => {
      console.error("Error from F1 Live Timing", err);
    });

    ltClient.on("reconnecting", async (count) => {
      console.log("Reconnecting to F1 Live Timing", count);
    });

    ltClient.on("feed", async (topic, data, timestamp) => {
      if (topic === "WeatherData")
        await showWeatherData(webhookClient, ltClient, timestamp);

      else if (topic === "SessionInfo")
        await showSessionInfo(webhookClient, ltClient, timestamp);

      else if (topic === "ArchiveStatus")
        await showArchiveStatus(webhookClient, ltClient, timestamp);

      else if (topic === "ContentStreams")
        await showContentStreams(webhookClient, ltClient, timestamp);

      else if (topic === "AudioStreams")
        await showAudioStreams(webhookClient, ltClient, timestamp);

      else if (topic === "TeamRadio" && ltClient.Current.SessionInfo) 
        await showTeamRadio(webhookClient, ltClient, timestamp);
    });

    ltClient.Start();

    let callAmount = 0;
    process.on('SIGINT', () => {
      if(callAmount < 1 && ltClient.ConnectionState() === "Connected") {
        webhookClient.send({
          content: "Cleaning up before exiting",
          username: 'Cleanup Bot',
          avatarURL: 'https://i.imgur.com/AfFp7pu.png',
        });

        ltClient
          .Unsubscribe(options.topics)
          .finally(ltClient.End);
      }

      callAmount++;
    });
  });

program
  .command("dump-year-index")
  .option("-o, --output <dir>", "Output directory to write index to", "./static/")
  .argument("<years...>", "Years to dump index for")
  .action(async (years: string[], options: { output: string }) => {
    console.log("Dumping index for years", years);
    console.log("Output directory", options.output);

    const toFetch = years.map(
      year => fetch(`https://livetiming.formula1.com/static/${year}/Index.json`)
    );

    for (const year of years) {
      await fs.mkdir(`${options.output}/${year}`, { recursive: true });
    }

    for await (const res of toFetch) {
      if (res.status === 404)
        continue;

      const resJson: ArchiveLiveTiming.YearIndex = await res.json();
      await fs.writeFile(
        `${options.output}/${resJson.Year}/Index.json`,
        JSON.stringify(resJson, null, 2)
      );
    }
  });

program
  .command("dump-session-index-for-year")
  .option("-o, --output <dir>", "Output directory to write index to", "./static/")
  .argument("<years...>", "Years to dump session index for")
  .action(async (years: string[], options: { output: string }) => {
    console.log("Dumping session index for years", years);
    console.log("Output directory", options.output);

    for (const year of years) {
      await fs.mkdir(`${options.output}/${year}`, { recursive: true });
    }

    const toFetch = [];

    for await (const yearIndexRes of years.map(year => fetch(`https://livetiming.formula1.com/static/${year}/Index.json`))) {
      if (yearIndexRes.status === 404)
        continue;

      else if (yearIndexRes.status >= 400)
        throw new Error();

      const yearIndexJson: ArchiveLiveTiming.YearIndex = await yearIndexRes.json();

      for (const meeting of yearIndexJson.Meetings) {
        for (const session of meeting.Sessions) {
          // Skip session 12001 for 2021 as it doesn't exist (FOM High Speed Track Test from 2022)
          if (yearIndexJson.Year === 2021 && session.Key === 12001)
            continue;

          if (session.Path) {
            const path = session.Path;

            toFetch.push(limiter(async () => {
              try {
                const res = await fetch(`https://livetiming.formula1.com/static/${path}Index.json`);

                if (res.status >= 400 && res.status !== 404)
                  throw new Error(`Failed to fetch ${path}Index.json`);

                return { res, path };
              } catch (err) {
                console.error("Error fetching", path, err);
                throw err;
              }
            }));
          } else if (session.Name) {
            const year = yearIndexJson.Year;
            const raceStartDate = meeting.Sessions[meeting.Sessions.length - 1].StartDate.substring(0, 10);
            const sessionStartDate = session.StartDate.substring(0, 10);
            const path = `${year}/${raceStartDate}_${meeting.Name.replace(/ /g, "_")}/${sessionStartDate}_${session.Name.replace(/ /g, "_")}/`;

            toFetch.push(limiter(async () => {
              try {
                const res = await fetch(`https://livetiming.formula1.com/static/${path}Index.json`);

                if (res.status >= 400 && res.status !== 404)
                  throw new Error(`Failed to fetch ${path}Index.json`);

                return { res, path };
              } catch (err) {
                console.error("Error fetching", path, err);
                throw err;
              }
            }));
          } else {
            console.warn("Session Path", session.Path);
            console.warn("Session Name", session.Name);
            console.warn("Skipping session", session.Key, "from meeting", meeting.Key, "as it doesn't have a path or name");
          }
        }
      }
    }

    for await (const { res, path } of toFetch) {
      if (res.status === 404)
        continue;

      await fs.mkdir(`${options.output}/${path}`, { recursive: true });
      await fs.writeFile(
        `${options.output}/${path}Index.json`,
        JSON.stringify(await res.json(), null, 2)
      );
    }
  });

program
  .command("dump-session-index")
  .option("-o, --output <dir>", "Output directory to write index to", "./static/")
  .argument("<session-paths...>", "Session paths to dump index for")
  .action(async (sessionPaths: string[], options: { output: string }) => {
    console.log("Dumping index for session paths", sessionPaths);
    console.log("Output directory", options.output);

    const sessionsIndexRes = sessionPaths.map(
      path =>
        limiter(async () => {
          try {
            const res = await fetch(`https://livetiming.formula1.com/static/${path}Index.json`);

            if (res.status >= 400 && res.status !== 404)
              throw new Error(`Failed to fetch ${path}Index.json`);

            return { res, path };
          } catch (err) {
            console.error("Error fetching", path, err);
            throw err;
          }
        })
    );

    for (const path of sessionPaths) {
      await fs.mkdir(`${options.output}/${path}`, { recursive: true });
    }

    for await (const { res, path } of sessionsIndexRes) {
      if (res.status === 404)
        continue;

      await fs.mkdir(`${options.output}/${path}`, { recursive: true });
      await fs.writeFile(
        `${options.output}/${path}Index.json`,
        JSON.stringify(await res.json(), null, 2)
      );
    }
  });

program
  .command("dump-session-feeds")
  .option("-o, --output <dir>", "Output directory to write feeds to", "./static/")
  .option("--include-index-feeds", "Include feeds from Index.json")
  .option("-f, --feeds <feeds...>", "Custom feeds to dump")
  .argument("<session-paths...>", "Session paths to dump feeds for")
  .action(async (sessionPaths: string[], options: { output: string, includeIndexFeeds?: boolean, feeds?: string[] }) => {
    console.log("Dumping feeds for session paths", sessionPaths);
    console.log("Output directory", options.output);

    if (!options.feeds)
      options.feeds = [];

    const toFetch = [];

    if (options.includeIndexFeeds) {
      const sessionsIndexRes = sessionPaths.map(
        path =>
          limiter(async () => {
            try {
              const res = await fetch(`https://livetiming.formula1.com/static/${path}Index.json`);

              if (res.status >= 400 && res.status !== 404)
                throw new Error(`Failed to fetch ${path}Index.json`);

              return { res, path };
            } catch (err) {
              console.error("Error fetching", path, err);
              throw err;
            }
          })
      );

      for await (const { res, path } of sessionsIndexRes) {
        if (res.status === 404)
          continue;

        const resJson: ArchiveLiveTiming.SessionIndex = await res.json();

        for (const key of Object.keys(resJson.Feeds)) {
          if (options.feeds.includes(key))
            continue;

          options.feeds.push(key);
        }
      }
    }

    for (const path of sessionPaths) {
      for (const feed of options.feeds) {
        toFetch.push(
          limiter(async () => {
            try {
              const res = await fetch(`https://livetiming.formula1.com/static/${path}${feed}.json`);

              if (res.status >= 400 && res.status !== 404)
                throw new Error(`Failed to fetch ${path}Index.json`);

              return { res, path, outPath: `${path}${feed}.json` };
            } catch (err) {
              console.error("Error fetching", `${path}${feed}.json`, err);
              throw err;
            }
          })
        );

        toFetch.push(
          limiter(async () => {
            try {
              const res = await fetch(`https://livetiming.formula1.com/static/${path}${feed}.jsonStream`);

              if (res.status >= 400 && res.status !== 404)
                throw new Error(`Failed to fetch ${path}Index.json`);

              return { res, path, outPath: `${path}${feed}.jsonStream` };
            } catch (err) {
              console.error("Error fetching", `${path}${feed}.json`, err);
              throw err;
            }
          })
        );
      }
    }

    for await (const { res, path, outPath } of toFetch) {
      if (res.status === 404)
        continue;

      console.log("Writing", outPath);

      await fs.mkdir(`${options.output}/${path}`, { recursive: true });
      await fs.writeFile(
        `${options.output}/${outPath}`,
        outPath.endsWith(".json") ?
          JSON.stringify(await res.json(), null, 2) :
          await res.text()
      );
    }
  });


  program
  .command("dump-session-feeds-for-year")
  .option("-o, --output <dir>", "Output directory to write feeds to", "./static/")
  .option("--include-index-feeds", "Include feeds from Index.json")
  .option("-f, --feeds <feeds...>", "Custom feeds to dump")
  .argument("<years...>", "Yeas to dump session feeds for")
  .action(async (years: string[], options: { output: string, includeIndexFeeds?: boolean, feeds?: string[] }) => {
    console.log("Dumping session feeds for years", years);
    console.log("Output directory", options.output);

    if (!options.feeds)
      options.feeds = [];

    const toFetch: Promise<{
      res: Response;
      path: string;
      outPath: string;
    }>[] = [];

    const paths = [];

    for await (const yearIndexRes of years.map(
      year => fetch(`https://livetiming.formula1.com/static/${year}/Index.json`)
    )) {
      if (yearIndexRes.status === 404)
        continue;

      else if (yearIndexRes.status >= 400)
        throw new Error();

      const yearIndexResJson: ArchiveLiveTiming.YearIndex = await yearIndexRes.json();

      for (const meeting of yearIndexResJson.Meetings) {
        for (const session of meeting.Sessions) {
          // Skip session 12001 for 2021 as it doesn't exist (FOM High Speed Track Test from 2022)
          if (yearIndexResJson.Year === 2021 && session.Key === 12001)
            continue;

          if (session.Path)
            paths.push(session.Path);

          else if (session.Name) {
            const year = yearIndexResJson.Year;
            const raceStartDate = meeting.Sessions[meeting.Sessions.length - 1].StartDate.substring(0, 10);
            const sessionStartDate = session.StartDate.substring(0, 10);
            const path = `${year}/${raceStartDate}_${meeting.Name.replace(/ /g, "_")}/${sessionStartDate}_${session.Name.replace(/ /g, "_")}/`;
            paths.push(path);
          }

          else
            console.warn("Unable to find or guess session path", session);
        }
      }
    }

    if (options.includeIndexFeeds) {
      const sessionsIndexRes = paths.map(
        path =>
          limiter(async () => {
            try {
              const res = await fetch(`https://livetiming.formula1.com/static/${path}Index.json`);

              if (res.status >= 400 && res.status !== 404)
                throw new Error();

              return { res, path };
            } catch (err) {
              console.error("Error fetching", path, err);
              throw err;
            }
          })
      );

      for await (const { res, path } of sessionsIndexRes) {
        if (res.status === 404)
          continue;

        const resJson: ArchiveLiveTiming.SessionIndex = await res.json();

        for (const key of Object.keys(resJson.Feeds)) {
          if (options.feeds.includes(key))
            continue;

          options.feeds.push(key);
        }
      }
    }

    for (const path of paths) {
      for (const feed of options.feeds) {
        toFetch.push(limiter(async () => {
          try {
            const res = await fetch(`https://livetiming.formula1.com/static/${path}${feed}.json`);

            if (res.status >= 400 && res.status !== 404)
              throw new Error();

            return { res, path, outPath: `${path}${feed}.json` };
          } catch (err) {
            console.error("Error fetching", `${path}${feed}.json`, err);
            throw err;
          }
        }));

        toFetch.push(limiter(async () => {
          try {
            const res = await fetch(`https://livetiming.formula1.com/static/${path}${feed}.jsonStream`);

            if (res.status >= 400 && res.status !== 404)
              throw new Error();

            return { res, path, outPath: `${path}${feed}.jsonStream` };
          } catch (err) {
            console.error("Error fetching", `${path}${feed}.json`, err);
            throw err;
          }
        }));
      }
    }

    console.log("Fetching", toFetch.length, "feeds");

    for await (const { res, path, outPath } of toFetch) {
      if (res.status === 404)
        continue;
      
      await fs.mkdir(`${options.output}/${path}`, { recursive: true });
      await fs.writeFile(
        `${options.output}/${outPath}`,
        outPath.endsWith(".json") ?
          JSON.stringify(await res.json(), null, 2) :
          await res.text()
      );
    }
  });

program
  .parseAsync(process.argv)
  .catch(console.error);
