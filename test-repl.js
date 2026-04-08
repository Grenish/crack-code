const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
rl.once('line', (line) => {
  console.log('Line:', line);
  
  // Now simulate permission prompt without closing rl
  process.stdout.write('Approve? [y/n] ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  
  const onData = (data) => {
    const char = data.toString();
    process.stdout.write(char + '\n');
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeListener('data', onData);
    console.log('Got:', char);
    process.exit(0);
  };
  process.stdin.on('data', onData);
});
