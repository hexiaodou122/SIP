// Build a drag-to-Applications disk image with macOS tools, without a downloaded DMG helper.
const fs=require('fs'),path=require('path'),os=require('os');
const {execFileSync}=require('child_process');
const root=path.join(__dirname,'..'),pkg=require('../package.json');
const app=path.join(root,'dist/mac-arm64',pkg.productName+'.app');
if(!fs.existsSync(app))throw Error('Build the arm64 app first.');
for(const file of [path.join(app,'Contents/MacOS',pkg.productName),path.join(app,'Contents/Resources/bin/sip-mouse')]){
 if(!execFileSync('lipo',['-archs',file],{encoding:'utf8'}).split(/\s+/).includes('arm64'))throw Error('The app and mouse helper must both support arm64.');
}
const output=path.join(root,'dist',`Sip-${pkg.version}-mac-arm64.dmg`);
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'sip-dmg-'));
try{
 execFileSync('ditto',[app,path.join(stage,pkg.productName+'.app')],{stdio:'inherit'});
 fs.symlinkSync('/Applications',path.join(stage,'Applications'));
 fs.writeFileSync(path.join(stage,'安装说明.txt'),'喝水养鱼 · SIP\n\n将喝水养鱼拖到 Applications，再从应用程序打开。\n\n本包适用于 Apple Silicon Mac。当前是未获 Apple 公证的试用版。\n如果 macOS 阻止打开，可在系统设置 → 隐私与安全性中检查对应应用的提示。\n');
 execFileSync('hdiutil',['create','-volname','喝水养鱼 SIP','-srcfolder',stage,'-format','UDZO','-ov',output],{stdio:'inherit'});
 console.log(output);
}finally{fs.rmSync(stage,{recursive:true,force:true});}
