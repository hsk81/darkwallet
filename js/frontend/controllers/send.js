'use strict';

define(['./module', 'frontend/port', 'darkwallet', 'util/btc', 'dwutil/currencyformat'],
function (controllers, Port, DarkWallet, BtcUtils, CurrencyFormat) {
  controllers.controller('WalletSendCtrl', ['$scope', '$window', 'notify', 'modals', '$wallet', function($scope, $window, notify, modals, $wallet) {
  
  var sendForm = $scope.forms.send;

  var dustThreshold = 5600;
  $scope.quicksend = {};

  $scope.resetSendForm = function() {
      sendForm.sending = false;
      sendForm.title = '';
      $scope.sendEnabled = false;
      sendForm.recipients = {
          fields: [
              { address: '', amount: '' }
          ],
          field_proto: { address: '', amount: '' }
      };
      var identity = DarkWallet.getIdentity();
      sendForm.fee = CurrencyFormat.asBtc(identity.wallet.fee);
      
      $scope.quicksend.next = false;
      $scope.quicksend.password = false;
  };
  
  var parseUri = function(uri, recipient) {
    recipient = recipient || 0;
    var pars = BtcUtils.parseURI(uri);
    if (!pars) {
      notify.warning('URI not supported');
    } else {
      pars.amount = CurrencyFormat.asSatoshis(pars.amount, 'BTC');
      pars.amount = CurrencyFormat.asBtc(pars.amount);
      sendForm.title = pars.message ? decodeURIComponent(pars.message) : '';
      sendForm.recipients.fields[recipient].address = pars.address;
      sendForm.recipients.fields[recipient].amount = pars.amount;
    }
  };

  $scope.updateBtcFiat = function(field) {
      var identity = DarkWallet.getIdentity();
      var currency = identity.settings.currency;
      var fiatCurrency = identity.settings.fiatCurrency;
      if (field.isFiatShown) {
          field.amount = CurrencyFormat.fiatToBtc(field.fiatAmount, currency, fiatCurrency);
      } else {
          field.fiatAmount = CurrencyFormat.btcToFiat(field.amount, currency, fiatCurrency);
      }
  };

  $scope.setPocket = function(pocket) {
      var identity = DarkWallet.getIdentity();
      if (pocket == 'any') {
          sendForm.sendPocketName = 'Any';
          // TODO: Any is only using default pocket right now.
          sendForm.pocketIndex = 0;
      } else if (typeof pocket == 'number') {
          sendForm.sendPocketName = identity.wallet.pockets.hdPockets[pocket].name;
          sendForm.pocketIndex = pocket;
      } else {
          var idx = parseInt(pocket.split(':')[1]);
          var fund = identity.wallet.multisig.funds[idx];
          sendForm.sendPocketName = fund.name;
          sendForm.pocketIndex = fund.address;
      }
  };

  var initialized, validAddresses;
  var initIdentity = function(identity) {
      if (!identity || initialized == identity.name) {
          return;
      }

      initialized = identity.name;
      validAddresses = [
          identity.wallet.versions.address,
          identity.wallet.versions.stealth.address,
          identity.wallet.versions.p2sh
      ]
 
      // Set the dust threshold
      dustThreshold = identity.wallet.wallet.dustThreshold;

      // Initialize the store and send form if it's the first time
      if (!sendForm || (sendForm.identity != identity.name)) {
          $scope.forms.send = { mixing: true,
                        sending: false,
                        sendPocket: 0,
                        autoAddEnabled: false,
                        identity: identity.name,
                        advanced: false };
          // Need to set the form here
          sendForm = $scope.forms.send;
          $scope.resetSendForm();
          if (location.hash.split('?')[1]) {
              parseUri(location.hash.split('?')[1].split('=')[1]);
          }
      }

      // init scope variables
      $scope.setPocket(sendForm.pocketIndex||0);
      if (!$scope.$$phase) {
          $scope.$apply();
      }
  };

  initIdentity(DarkWallet.getIdentity());
  
  // Identity ready
  Port.connectNg('wallet', $scope, function(data) {
    if (data.type == 'ready') {
        // Set the default fee
        var identity = DarkWallet.getIdentity();
        initIdentity(identity);
    }
  });

  var onUpdateRadar = function(radar, task) {
      var progressBar = $window.document.getElementById('send-progress');
      var button = $window.document.getElementById('send-button');

      task.radar = radar;

      // Check if we're finished
      if (radar >= 0.75) {
          // if the controller is still here and button still active, reset
          if (button && button.classList.contains('working')) {
              notify.success('Transaction finished propagating');
              button.classList.remove('working');
              $scope.resetSendForm();
              if (!$scope.$$phase) {
                  $scope.$apply();
              };
          }
          return;
      }

      // Proceed if radar is updating
      if (button && !button.classList.contains('working')) {
          button.classList.add('working');
      }

      // Progress bar must be updated at the end
      if (progressBar) {
          progressBar.style.width = radar*100 + '%';
      }
  };


  var prepareRecipients = function() {
      var identity = DarkWallet.getIdentity();
      var recipients = [];
      var totalAmount = 0;
      
      if ($scope.quicksend.next) {
          sendForm.recipients.fields = [{
            address: $scope.quicksend.address,
            amount: $scope.quicksend.amount
          }];
      }
      
      sendForm.recipients.fields.forEach(function(recipient) {
          if (!BtcUtils.validateAddress(recipient.address, validAddresses)) {
              return;
          }
          recipient.contact = identity.contacts.findByAddress(recipient.address);
          
          if (!recipient.amount || !recipient.address) {
              return;
          }
          var amount = CurrencyFormat.asSatoshis(recipient.amount);
          totalAmount += amount;
          recipients.push({address: recipient.address, amount: amount});
      });
      return {amount: totalAmount, recipients: recipients};
  };

  $scope.validateSendForm = function() {
      var identity = DarkWallet.getIdentity();
      if ($scope.quicksend.address) {
          $scope.quicksend.contact = identity.contacts.findByAddress($scope.quicksend.address);
          if ($scope.quicksend.contact) {
              $scope.quicksend.next = true;
          }
      }
      var spend = prepareRecipients();
      if ((spend.recipients.length > 0) && (spend.amount > dustThreshold)) {
          $scope.sendEnabled = true;
      } else {
          $scope.sendEnabled = false;
      }
      if ($scope.sendEnabled) {
          $scope.autoAddField();
      }
  };

  var finishMix = function(metadata, amountNote, password) {
      var onMixing = function(err, mixingTask) {
          if (err) {
              notify.error('Error sending to mixer ('+mixingTask.task.state+')', amountNote);
          } else {
              notify.note('Sent to mixer ('+mixingTask.task.state+')', amountNote);
          }
      };

      $scope.resetSendForm();
      var walletService = DarkWallet.service.wallet;
      walletService.mixTransaction(metadata.tx, metadata, password, onMixing);
  };

  var finishSign = function(metadata, amountNote, password) {
      // callback waiting for radar feedback
      var isBroadcasted = false;
      var radarCache = {radar: 0};
      var onBroadcast = function(error, task) {
          console.log("broadcast feedback", error, task);
          if (error) {
              var errorMessage = error.message || ''+error;
              notify.error("Error broadcasting", errorMessage);
              sendForm.sending = false;
          } else if (task && task.type == 'signatures') {
              notify.note('Signatures pending', amountNote)
          } else if (task && task.type == 'radar') {
              onUpdateRadar(task.radar || 0, radarCache);
              if (!isBroadcasted) {
                  notify.success('Transaction sent', amountNote);
                  isBroadcasted = true;
              }
          }
      };

      var walletService = DarkWallet.service.wallet;
      walletService.signTransaction(metadata.tx, metadata, password, onBroadcast, true);
  };

  var onPassword = function(metadata, amountNote, password) {
      if (sendForm.mixing) {
          finishMix(metadata, amountNote, password);
      } else {
          finishSign(metadata, amountNote, password);
      }
  };



  $scope.sendBitcoins = function() {
      // get a free change address
      var changeAddress = $wallet.getChangeAddress(sendForm.pocketIndex);

      // Prepare recipients
      var spend = prepareRecipients();
      var recipients = spend.recipients;
      var totalAmount = spend.amount;

      if (!recipients.length) {
          notify.note('You need to fill in at least one recipient');
          return;
      }

      if (totalAmount < dustThreshold) {
          notify.note('Amount is below the dust threshold', totalAmount+'<'+dustThreshold);
          return;
      }

      sendForm.sending = true;
      var fee = CurrencyFormat.asSatoshis(sendForm.fee);

      // prepare the transaction
      var metadata;
      var identity = DarkWallet.getIdentity();

      try {
          metadata = identity.wallet.prepareTx(sendForm.pocketIndex,
                                               recipients,
                                               changeAddress,
                                               fee)
      } catch (error) {
          var errorMessage = error.message || ''+error;
          notify.error("Failed preparing transaction", errorMessage);
          sendForm.sending = false;
          return;
      }

      var amountNote = (fee + totalAmount) + ' satoshis';

      // Now ask for the password before continuing with the next step   
      if (modals.password) {
        modals.password('Unlock password', function(password) {
          onPassword(metadata, amountNote, password);
        });
      } else {
        $scope.quicksend.password = true;
        $scope.quicksend.onPassword = function(password) {
          onPassword(metadata, amountNote, password);
        };
      }
      
      
  };

  $scope.addAddress = function(data, vars) {
      vars.field.address = data;
      $scope.validateSendForm();
  };
  
  $scope.onQrModalOkSend = function(data, vars) {
      $scope.onQrModalOk(data, vars);
      $scope.validateSendForm();
  };

  $scope.addField = function() {
      // add the new option to the model
      sendForm.recipients.fields.push(sendForm.recipients.field_proto);
      // clear the option.
      sendForm.recipients.field_proto = { address: '', amount: '' };
  };
  
  $scope.autoAddField = function() {
      if (!sendForm.autoAddEnabled) {
          return;
      }
      var fields = sendForm.recipients.fields;
      var lastFields = fields[fields.length - 1];
      var field_keys = Object.keys(sendForm.recipients.field_proto);
      var empty;
      field_keys.forEach(function(key) {
          empty = empty || lastFields[key];
      });
      if (empty) {
          $scope.addField();
      }
  };
  
  $scope.toggleCoinJoin = function() {
      sendForm.mixing = !sendForm.mixing;
  };

  $scope.enableAutoAddFields = function() {
      $scope.addField();
      sendForm.autoAddEnabled = true;
  };
}]);
});
