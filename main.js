require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytSearch = require('youtube-search-api');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const queues = new Map();


class ServerQueue {
  constructor(textChannel, voiceChannel) {
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.connection = null;
    this.songs = [];
    this.player = createAudioPlayer();
    this.isPlaying = false;
  }
}

client.once('ready', () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} servers`);
  client.user.setActivity('!help for commands', { type: 'LISTENING' });
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  const commands = {
    play: () => play(message, args),
    skip: () => skip(message),
    stop: () => stop(message),
    queue: () => showQueue(message),
    pause: () => pause(message),
    resume: () => resume(message),
    nowplaying: () => nowPlaying(message),
    help: () => help(message)
  };

  if (commands[command]) {
    try {
      await commands[command]();
    } catch (error) {
      console.error(`Error executing ${command}:`, error);
      message.reply('❌ An error occurred while executing that command!');
    }
  }
});

async function play(message, args) {
  const voiceChannel = message.member.voice.channel;
  
  if (!voiceChannel) {
    return message.reply('❌ You need to be in a voice channel to play music!');
  }

  const permissions = voiceChannel.permissionsFor(message.client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return message.reply('❌ I need permissions to join and speak in your voice channel!');
  }

  if (!args.length) {
    return message.reply('❌ Please provide a song name or URL!\nExample: `!play despacito`');
  }

  const query = args.join(' ');
  let serverQueue = queues.get(message.guild.id);

  try {
    await message.channel.send('🔍 Searching...');
    
    let songInfo;
    
    
    if (ytdl.validateURL(query)) {
      songInfo = await ytdl.getInfo(query);
    } else {
      const searchResults = await ytSearch.GetListByKeyword(query, false, 1);
      if (!searchResults.items || searchResults.items.length === 0) {
        return message.reply('❌ No results found!');
      }
      const videoId = searchResults.items[0].id;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      songInfo = await ytdl.getInfo(url);
    }

    const song = {
      title: songInfo.videoDetails.title,
      url: songInfo.videoDetails.video_url,
      duration: formatDuration(songInfo.videoDetails.lengthSeconds),
      thumbnail: songInfo.videoDetails.thumbnails[0].url,
      requester: message.author.tag
    };

    if (!serverQueue) {
     
      serverQueue = new ServerQueue(message.channel, voiceChannel);
      queues.set(message.guild.id, serverQueue);
      serverQueue.songs.push(song);

      try {
      
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
        });

        serverQueue.connection = connection;
        connection.subscribe(serverQueue.player);

        
    
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
          } catch (error) {
            connection.destroy();
            queues.delete(message.guild.id);
          }
        });

        await playSong(message.guild, serverQueue.songs[0]);
      } catch (err) {
        console.error(err);
        queues.delete(message.guild.id);
        return message.reply('❌ There was an error connecting to the voice channel!');
      }
    } else {
      serverQueue.songs.push(song);
      
      const embed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('✅ Added to Queue')
        .setDescription(`**${song.title}**`)
        .addFields(
          { name: 'Duration', value: song.duration, inline: true },
          { name: 'Position in Queue', value: `${serverQueue.songs.length}`, inline: true }
        )
        .setThumbnail(song.thumbnail)
        .setFooter({ text: `Requested by ${message.author.tag}` });
      
      return message.channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('Play error:', error);
    message.reply('❌ There was an error playing that song! Make sure it\'s a valid YouTube URL or search term.');
  }
}

async function playSong(guild, song) {
  const serverQueue = queues.get(guild.id);
  
  if (!song) {
    serverQueue.connection.destroy();
    queues.delete(guild.id);
    return;
  }

  try {
    const stream = ytdl(song.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25
    });

    const resource = createAudioResource(stream);
    serverQueue.player.play(resource);
    serverQueue.isPlaying = true;

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('🎵 Now Playing')
      .setDescription(`**${song.title}**`)
      .addFields(
        { name: 'Duration', value: song.duration, inline: true },
        { name: 'Requested by', value: song.requester, inline: true }
      )
      .setThumbnail(song.thumbnail)
      .setURL(song.url);

    serverQueue.textChannel.send({ embeds: [embed] });

    serverQueue.player.on(AudioPlayerStatus.Idle, () => {
      serverQueue.songs.shift();
      playSong(guild, serverQueue.songs[0]);
    });

    serverQueue.player.on('error', error => {
      console.error('Player error:', error);
      serverQueue.textChannel.send('❌ An error occurred while playing the song!');
      serverQueue.songs.shift();
      playSong(guild, serverQueue.songs[0]);
    });
  } catch (error) {
    console.error('Stream error:', error);
    serverQueue.textChannel.send('❌ Could not play this song!');
    serverQueue.songs.shift();
    playSong(guild, serverQueue.songs[0]);
  }
}

function skip(message) {
  const serverQueue = queues.get(message.guild.id);
  
  if (!message.member.voice.channel) {
    return message.reply('❌ You need to be in a voice channel to skip!');
  }
  if (!serverQueue || !serverQueue.isPlaying) {
    return message.reply('❌ There is nothing playing!');
  }

  serverQueue.player.stop();
  message.reply('⏭️ Skipped the current song!');
}

function stop(message) {
  const serverQueue = queues.get(message.guild.id);
  
  if (!message.member.voice.channel) {
    return message.reply('❌ You need to be in a voice channel!');
  }
  if (!serverQueue) {
    return message.reply('❌ There is nothing playing!');
  }

  serverQueue.songs = [];
  serverQueue.player.stop();
  serverQueue.connection.destroy();
  queues.delete(message.guild.id);
  message.reply('⏹️ Stopped playing and cleared the queue!');
}

function pause(message) {
  const serverQueue = queues.get(message.guild.id);
  
  if (!message.member.voice.channel) {
    return message.reply('❌ You need to be in a voice channel!');
  }
  if (!serverQueue || !serverQueue.isPlaying) {
    return message.reply('❌ There is nothing playing!');
  }

  serverQueue.player.pause();
  serverQueue.isPlaying = false;
  message.reply('⏸️ Paused the music!');
}

function resume(message) {
  const serverQueue = queues.get(message.guild.id);
  
  if (!message.member.voice.channel) {
    return message.reply('❌ You need to be in a voice channel!');
  }
  if (!serverQueue) {
    return message.reply('❌ There is nothing in the queue!');
  }

  serverQueue.player.unpause();
  serverQueue.isPlaying = true;
  message.reply('▶️ Resumed the music!');
}

function nowPlaying(message) {
  const serverQueue = queues.get(message.guild.id);
  
  if (!serverQueue || !serverQueue.songs.length) {
    return message.reply('❌ There is nothing playing!');
  }

  const song = serverQueue.songs[0];
  const embed = new EmbedBuilder()
    .setColor('#ff00ff')
    .setTitle('🎵 Currently Playing')
    .setDescription(`**${song.title}**`)
    .addFields(
      { name: 'Duration', value: song.duration, inline: true },
      { name: 'Requested by', value: song.requester, inline: true }
    )
    .setThumbnail(song.thumbnail)
    .setURL(song.url);

  message.channel.send({ embeds: [embed] });
}

function showQueue(message) {
  const serverQueue = queues.get(message.guild.id);
  
  if (!serverQueue || !serverQueue.songs.length) {
    return message.reply('❌ The queue is empty!');
  }

  const embed = new EmbedBuilder()
    .setColor('#ffff00')
    .setTitle('📜 Music Queue')
    .setDescription(
      serverQueue.songs
        .slice(0, 10)
        .map((song, index) => {
          return `${index === 0 ? '▶️' : `${index}.`} **${song.title}** - ${song.duration}`;
        })
        .join('\n')
    )
    .setFooter({ text: `${serverQueue.songs.length} song(s) in queue` });

  if (serverQueue.songs.length > 10) {
    embed.addFields({ name: 'And more...', value: `${serverQueue.songs.length - 10} more songs` });
  }

  message.channel.send({ embeds: [embed] });
}

function help(message) {
  const embed = new EmbedBuilder()
    .setColor('#00ffff')
    .setTitle('🎵 Music Bot Commands')
    .setDescription('Here are all available commands:')
    .addFields(
      { name: '!play <song name or URL>', value: 'Play a song from YouTube' },
      { name: '!skip', value: 'Skip the current song' },
      { name: '!stop', value: 'Stop playing and clear the queue' },
      { name: '!pause', value: 'Pause the current song' },
      { name: '!resume', value: 'Resume the paused song' },
      { name: '!queue', value: 'Show the current queue' },
      { name: '!nowplaying', value: 'Show the currently playing song' },
      { name: '!help', value: 'Show this help message' }
    )
    .setFooter({ text: 'Enjoy the music! 🎶' });

  message.channel.send({ embeds: [embed] });
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}


process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

client.login(process.env.DISCORD_TOKEN);