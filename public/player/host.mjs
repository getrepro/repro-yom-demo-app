import { streamGame } from './stream-host.mjs';
const { allocation } = window.hostConfig;
const width = allocation.width, height = allocation.height;
let controls = {};
let frame = 0;

class Circuit extends Phaser.Scene {
  create() {
    const track = this.add.graphics();
    track.fillStyle(0x142529).fillRect(0, 0, width, height);
    track.lineStyle(1, 0x263a3c, 0.6);
    for (let x = 0; x < width; x += 48) track.lineBetween(x, 0, x, height);
    for (let y = 0; y < height; y += 48) track.lineBetween(0, y, width, y);
    track.fillStyle(0x394748).fillRoundedRect(width * .10, height * .18, width * .8, height * .66, height * .24);
    track.fillStyle(0x132c27).fillRoundedRect(width * .27, height * .36, width * .46, height * .30, height * .13);
    track.lineStyle(3, 0xb4d580, .8).strokeRoundedRect(width * .10, height * .18, width * .8, height * .66, height * .24);
    track.lineStyle(2, 0x658d70).strokeRoundedRect(width * .27, height * .36, width * .46, height * .30, height * .13);
    for (let i = 0; i < 10; i++) {
      track.fillStyle(i % 2 ? 0xffffff : 0x151b1b).fillRect(width * .49, height * .19 + i * height * .016, 24, height * .016);
      track.fillStyle(i % 2 ? 0x151b1b : 0xffffff).fillRect(width * .49 + 24, height * .19 + i * height * .016, 24, height * .016);
    }
    const car = this.make.graphics({ x: 0, y: 0 }, false);
    car.fillStyle(0xb8e97c).fillRoundedRect(0, 0, 40, 22, 5);
    car.fillStyle(0x1b3437).fillRoundedRect(11, 3, 15, 16, 3);
    car.fillStyle(0xffffff).fillRect(36, 3, 3, 5).fillRect(36, 14, 3, 5);
    car.generateTexture('car', 40, 22);
    this.car = this.physics.add.image(width * .44, height * .27, 'car');
    this.car.setCollideWorldBounds(true).setDrag(120).setMaxVelocity(350);
    this.pace = this.add.image(width * .65, height * .27, 'car').setTint(0xe7a38c);
    this.add.text(28, 25, 'CIRCUIT / 01', { fontFamily: 'Arial', fontSize: '24px', fontStyle: 'bold', color: '#e9f4ee' });
    this.add.text(width / 2, height * .47, 'FIND YOUR LINE', { fontFamily: 'Arial', fontSize: '22px', color: '#92b7a4' }).setOrigin(.5);
    this.hud = this.add.text(28, 62, '', { fontFamily: 'monospace', fontSize: '15px', color: '#adcbc0' });
    this.timeText = this.add.text(width - 28, 30, '', { fontFamily: 'monospace', fontSize: '19px', color: '#e9f4ee' }).setOrigin(1, 0);
    this.startedAt = this.time.now;
    streamGame({ canvas: this.game.canvas, pause: () => this.game.loop.sleep(), destroy: () => this.game.destroy(true),
      applyInput: input => {
        if (input.action === 'reset') { controls = {}; return true; }
        if (!['down', 'up'].includes(input.action)
          || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyW','KeyA','KeyS','KeyD'].includes(input.code)) return false;
        controls[input.code] = input.action === 'down'; return true;
      } });
  }
  update(time) {
    frame++;
    if (controls.ArrowLeft || controls.KeyA) this.car.angle -= 3;
    if (controls.ArrowRight || controls.KeyD) this.car.angle += 3;
    if (controls.ArrowUp || controls.KeyW) this.physics.velocityFromRotation(this.car.rotation, 250, this.car.body.acceleration);
    else if (controls.ArrowDown || controls.KeyS) this.physics.velocityFromRotation(this.car.rotation, -140, this.car.body.acceleration);
    else this.car.setAcceleration(0);
    const phase = time / 2600;
    this.pace.setPosition(width * .5 + Math.cos(phase) * width * .32, height * .51 + Math.sin(phase) * height * .24);
    this.pace.setRotation(phase + Math.PI / 2);
    this.hud.setText(`TIME TRIAL     ${Math.round(this.car.body.speed)} KM/H`);
    this.timeText.setText(`${((time - this.startedAt) / 1000).toFixed(2)}s`);
    window.renderedFrames = frame;
  }
}
new Phaser.Game({ type: Phaser.CANVAS, width, height, parent: 'game',
  backgroundColor: '#142529', banner: false, audio: { noAudio: true },
  physics: { default: 'arcade', arcade: { debug: false } }, scene: Circuit,
  fps: { target: allocation.fps, forceSetTimeOut: true } });
